/**
 * Reading tiles, at a rate the frame budget can afford.
 *
 * The recogniser costs about a millisecond per glyph, and a sheet of letters
 * offers thirty candidates. Recognising all of them every frame is thirty
 * milliseconds — the whole budget, spent re-reading letters that have not moved
 * since the last frame. Tiles lie on a table; they are stationary almost always.
 *
 * So a reading is cached against the position and size of the blob that
 * produced it, and only genuinely new candidates are recognised — at most a few
 * per frame. In the steady state, a board full of tiles costs nothing at all;
 * when tiles are being laid out, the backlog clears over the next handful of
 * frames, which is well inside the time the stabiliser takes to trust a reading
 * anyway.
 */

import { readGlyph } from "./glyph-net.js";
import { GLYPH_SIZE, normaliseGlyph } from "./glyph.js";
import type { RectifiedFrame } from "./rectify.js";
import type { CropSource } from "./native-crop.js";

/**
 * Somewhere on the board worth reading a glyph out of.
 *
 * Deliberately not a blob. Choosing what to look at is the caller's job, and it
 * has two ways to do it — the tiles themselves, which is much the better one,
 * or blobs of ink for tiles that have no frame to find. See tile-finder.ts.
 */
export interface Candidate {
  cx: number;
  cy: number;
  /** Side of the square to crop, in board pixels. */
  side: number;
}

/** Oversampling factor for the crop, so normalisation has detail to work with. */
const CROP = GLYPH_SIZE * 2;

/**
 * How much of a normalised bitmap must be ink for it to be worth reading.
 *
 * Below the floor there is nothing there — blank paper, or a mark too faint to
 * have survived normalisation. Above the ceiling it is a solid shape, a colour
 * token or a blot, not a letter. Letters land between: normalisation crops to
 * the ink and scales it up, so even a thin "I" fills a reasonable share.
 */
const MIN_INK = 0.1;
const MAX_INK = 0.8;

export interface TileReading {
  char: string;
  /** Probability of the winner, 0-1. */
  score: number;
  /** How far ahead of the runner-up, 0-1. */
  margin: number;
  cx: number;
  cy: number;
  size: number;
}

export interface ReaderOptions {
  /** Characters this game uses. Restricting is worth several percent of accuracy. */
  alphabet?: string;
  /** Reject readings less confident than this. */
  minConfidence?: number;
  /** Reject readings this close to their runner-up. */
  minMargin?: number;
  /** How many new candidates to recognise per frame. */
  budget?: number;
  /** Where to take crops from; falls back to the rectified board. */
  source?: CropSource;
  /**
   * Try the other three quarter turns when an upright reading is unconvincing.
   *
   * The model is trained on upright glyphs, because that is how letters lie on
   * a sheet. A tile dropped sideways is rare enough that paying four times the
   * cost for every glyph would be the wrong trade — so the cost is paid only
   * where the upright answer is weak.
   */
  rotationFallback?: boolean;
}

interface CacheEntry {
  /** null means "looked at this and it is not a character". */
  reading: TileReading | null;
  /** Where on the board this entry is, so a blob can be matched to it. */
  cx: number;
  cy: number;
  /** Blob size when the entry was made, so a changed blob can be re-read. */
  side: number;
  lastSeen: number;
  /** Frame after which a refusal is worth testing again. Unused for readings. */
  recheck: number;
}

/**
 * How long an entry survives without its blob being seen. Generous, because a
 * tile briefly covered by a hand should not have to be read from scratch.
 */
const FORGET = 30;

/**
 * Refusals are cached too, and that is not an optimisation.
 *
 * A real sheet hands over far more junk than letters — border fragments, the
 * rims of colour tokens, specks. Without this, every one of them costs a slot
 * of the per-frame budget on every frame, forever, and the letters behind them
 * are never reached at all. The board looks empty and the recogniser looks
 * broken, when in fact it never got asked.
 *
 * But a refusal is a claim about a place, and places change: a tile can be laid
 * down where a border fragment was. Two things reopen the question — the blob
 * changing size by more than a hair, which is what happens when something is
 * put down, and the plain passage of time, as a backstop for the case where it
 * does not.
 */
const RECHECK_REFUSAL = 90;
const SIDE_TOLERANCE = 0.12;

export class TileReader {
  private cache: CacheEntry[] = [];
  private frame = 0;
  /** Where the last frame stopped spending its budget. See the note in read(). */
  private cursor = 0;

  /** Forget everything; the board has changed under us. */
  reset(): void {
    this.cache.length = 0;
    this.cursor = 0;
  }

  get cached(): number {
    return this.cache.length;
  }

  /**
   * The entry for a blob, matched on proximity rather than an exact key.
   *
   * A tile's centroid wanders a pixel or two between frames as the mask edges
   * move, and a grid key turns that into a miss every time the wander crosses a
   * cell boundary — so the reading is thrown away and paid for again, which on
   * a full sheet means the budget never reaches the end of the queue.
   */
  private find(cx: number, cy: number, side: number): CacheEntry | undefined {
    const near = Math.max(2, side * 0.3);
    let best: CacheEntry | undefined;
    let bestD = near * near;
    for (const e of this.cache) {
      const dx = e.cx - cx;
      const dy = e.cy - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  read(frame: RectifiedFrame, candidates: Candidate[], opts: ReaderOptions = {}): TileReading[] {
    const minConfidence = opts.minConfidence ?? 0.45;
    const minMargin = opts.minMargin ?? 0.12;
    const budget = opts.budget ?? 4;
    const crop = new Uint8ClampedArray(CROP * CROP);
    const now = ++this.frame;
    const out: TileReading[] = [];

    // Pass one: report everything already known, and collect what is not.
    const unknown: Candidate[] = [];
    for (const blob of candidates) {
      const side = blob.side;
      const hit = this.find(blob.cx, blob.cy, side);
      if (hit) {
        hit.lastSeen = now;
        hit.cx = blob.cx;
        hit.cy = blob.cy;
        if (hit.reading) {
          hit.reading.cx = blob.cx;
          hit.reading.cy = blob.cy;
          out.push({ ...hit.reading });
          continue;
        }
        const grew = Math.abs(side - hit.side) > hit.side * SIDE_TOLERANCE;
        if (!grew && now < hit.recheck) continue;
        this.cache.splice(this.cache.indexOf(hit), 1);
      }
      unknown.push(blob);
    }

    /*
     * Pass two: spend the budget, resuming where the last frame left off.
     *
     * The order candidates arrive in is not neutral — labelBlobs returns them
     * largest first, and ink area is very nearly a measure of how fat a letter
     * is. Always starting at the front means M, W and B are re-read forever
     * while A, I, E, F, T and 1 wait at the back of a queue the budget never
     * reaches. On a real sheet that is not a delay, it is a permanent blind
     * spot: those letters simply never appear. Rotating the starting point
     * gives every candidate its turn, and the whole board is covered in
     * ceil(n / budget) frames no matter what order it arrives in.
     */
    if (this.cursor >= unknown.length) this.cursor = 0;
    for (let n = 0; n < unknown.length && n < budget; n++) {
      const blob = unknown[(this.cursor + n) % unknown.length];
      const side = blob.side;
      const refuse = () =>
        this.cache.push({
          reading: null,
          cx: blob.cx,
          cy: blob.cy,
          side,
          lastSeen: now,
          recheck: now + RECHECK_REFUSAL,
        });

      if (!opts.source?.sample(blob.cx, blob.cy, side, 0, crop, CROP)) {
        sampleUpright(frame, blob.cx, blob.cy, side, crop, CROP);
      }

      /*
       * Ink reaching the edge of the crop is somebody else's — a neighbouring
       * tile's frame, most often — and it has to go before the bounding box is
       * taken, or the glyph is scaled down to sit beside it.
       *
       * Unconditional, and that matters more than it looks. The trainer
       * normalises its samples the same way, so this is the one distribution
       * the model has ever seen; making it depend on which path found the
       * candidate would hand the other path a model trained for something else.
       */
      const normalised = normaliseGlyph(crop, CROP, CROP, { dropEdgeTouching: true });

      // The amount of ink, before the model is asked. Cheaper than inference,
      // and it takes out the two cases the model has least to say about: a
      // patch of blank paper, and a shape so solid it cannot be a letter.
      let ink = 0;
      for (let i = 0; i < normalised.length; i++) ink += normalised[i];
      const density = ink / normalised.length;
      if (density < MIN_INK || density > MAX_INK) {
        refuse();
        continue;
      }

      let result = readGlyph(normalised, opts.alphabet);

      if (opts.rotationFallback && result && result.confidence < 0.55) {
        for (let turns = 1; turns < 4; turns++) {
          const rotated = readGlyph(rotate(normalised, turns as 1 | 2 | 3), opts.alphabet);
          if (rotated && rotated.confidence > (result?.confidence ?? 0)) result = rotated;
        }
      }

      // readGlyph returns null when the model's own reject class wins: not a
      // weak letter, but a considered "that is not one of mine".
      if (!result || result.confidence < minConfidence || result.margin < minMargin) {
        refuse();
        continue;
      }

      const reading: TileReading = {
        char: result.char,
        score: result.confidence,
        margin: result.margin,
        cx: blob.cx,
        cy: blob.cy,
        size: side,
      };
      this.cache.push({ reading, cx: blob.cx, cy: blob.cy, side, lastSeen: now, recheck: 0 });
      out.push({ ...reading });
    }
    this.cursor += budget;

    for (let i = this.cache.length - 1; i >= 0; i--) {
      if (now - this.cache[i].lastSeen > FORGET) this.cache.splice(i, 1);
    }

    return out;
  }
}

function rotate(src: Uint8Array, turns: 1 | 2 | 3): Uint8Array {
  const n = GLYPH_SIZE;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!src[y * n + x]) continue;
      const nx = turns === 1 ? n - 1 - y : turns === 2 ? n - 1 - x : y;
      const ny = turns === 1 ? x : turns === 2 ? n - 1 - y : n - 1 - x;
      out[ny * n + nx] = 1;
    }
  }
  return out;
}

/** Sample a square window of the luma plane, from the rectified board. */
function sampleUpright(
  frame: RectifiedFrame,
  cx: number,
  cy: number,
  side: number,
  out: Uint8ClampedArray,
  outSize: number,
): void {
  const { w, h } = frame.size;
  const step = side / outSize;
  for (let y = 0; y < outSize; y++) {
    const sy = Math.round(cy + (y - outSize / 2 + 0.5) * step);
    for (let x = 0; x < outSize; x++) {
      const sx = Math.round(cx + (x - outSize / 2 + 0.5) * step);
      // Outside the board reads as paper-white, so the edge never looks like ink.
      out[y * outSize + x] = sx < 0 || sy < 0 || sx >= w || sy >= h ? 255 : frame.gray[sy * w + sx];
    }
  }
}
