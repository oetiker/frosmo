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

import type { Blob } from "./blobs.js";
import { readGlyph } from "./glyph-net.js";
import { GLYPH_SIZE, normaliseGlyph } from "./glyph.js";
import type { RectifiedFrame } from "./rectify.js";
import type { CropSource } from "./native-crop.js";
import { glyphCandidate, glyphLimits, type GlyphLimits } from "./tiles.js";

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
  limits?: Partial<GlyphLimits>;
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

interface CacheEntry extends TileReading {
  lastSeen: number;
}

export class TileReader {
  private cache = new Map<number, CacheEntry>();
  private frame = 0;

  /** Forget everything; the board has changed under us. */
  reset(): void {
    this.cache.clear();
  }

  get cached(): number {
    return this.cache.size;
  }

  read(frame: RectifiedFrame, blobs: Blob[], opts: ReaderOptions = {}): TileReading[] {
    const limits: GlyphLimits = { ...glyphLimits(frame.size.w, frame.size.h), ...opts.limits };
    const minConfidence = opts.minConfidence ?? 0.45;
    const minMargin = opts.minMargin ?? 0.12;
    let budget = opts.budget ?? 4;
    const crop = new Uint8ClampedArray(CROP * CROP);
    const now = ++this.frame;
    const out: TileReading[] = [];

    for (const blob of blobs) {
      if (glyphCandidate(blob, limits) !== "ok") continue;

      const bw = blob.maxX - blob.minX + 1;
      const bh = blob.maxY - blob.minY + 1;
      const side = Math.max(bw, bh) * 1.3;
      const key = cacheKey(blob.cx, blob.cy, frame.size.w);

      const hit = this.cache.get(key);
      if (hit) {
        hit.lastSeen = now;
        hit.cx = blob.cx;
        hit.cy = blob.cy;
        out.push({ ...hit });
        continue;
      }

      if (budget <= 0) continue;
      budget--;

      if (!opts.source?.sample(blob.cx, blob.cy, side, 0, crop, CROP)) {
        sampleUpright(frame, blob.cx, blob.cy, side, crop, CROP);
      }

      const normalised = normaliseGlyph(crop, CROP, CROP);

      // The network has no answer for "nothing". Given an empty bitmap it
      // reports whichever class its biases favour, with enough confidence to
      // be believed — so a blank patch of paper became a letter. Given a solid
      // one it does the same. Both are rejected here, on the amount of ink,
      // before the question is asked.
      let ink = 0;
      for (let i = 0; i < normalised.length; i++) ink += normalised[i];
      const density = ink / normalised.length;
      if (density < MIN_INK || density > MAX_INK) continue;

      let result = readGlyph(normalised, opts.alphabet);

      if (opts.rotationFallback && result && result.confidence < 0.55) {
        for (let turns = 1; turns < 4; turns++) {
          const rotated = readGlyph(rotate(normalised, turns as 1 | 2 | 3), opts.alphabet);
          if (rotated && rotated.confidence > (result?.confidence ?? 0)) result = rotated;
        }
      }

      if (!result || result.confidence < minConfidence || result.margin < minMargin) continue;

      const entry: CacheEntry = {
        char: result.char,
        score: result.confidence,
        margin: result.margin,
        cx: blob.cx,
        cy: blob.cy,
        size: side,
        lastSeen: now,
      };
      this.cache.set(key, entry);
      out.push({ ...entry });
    }

    // Drop readings for tiles that have gone. Generous, because a tile briefly
    // covered by a hand should not have to be read again from scratch.
    for (const [key, entry] of this.cache) {
      if (now - entry.lastSeen > 30) this.cache.delete(key);
    }

    return out;
  }
}

/**
 * Cache key from position, on a coarse grid.
 *
 * Coarse on purpose: a tile jitters by a pixel or two between frames as the
 * mask edges move, and a key that changed with the jitter would never hit.
 */
function cacheKey(cx: number, cy: number, width: number): number {
  return (Math.round(cy / 5) * width + Math.round(cx / 5)) | 0;
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
