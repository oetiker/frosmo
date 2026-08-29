/**
 * Tiles: blobs that look like printed pieces, read as characters.
 *
 * Runs on top of the occupancy blobs rather than its own segmentation — a tile
 * is a thing on the table first and a letter second.
 */

import type { Blob } from "./blobs.js";
import { GLYPH_SIZE, matchGlyph, normaliseGlyph, type GlyphAtlas, type GlyphMatch } from "./glyph.js";
import type { CropSource } from "./native-crop.js";
import type { RectifiedFrame } from "./rectify.js";

export interface Tile extends GlyphMatch {
  blobId: number;
  /** Board pixels. */
  cx: number;
  cy: number;
  /** Approximate side length in board pixels. */
  size: number;
  /** Mean colour of the tile's ink. */
  r: number;
  g: number;
  b: number;
}

export interface TileOptions {
  /** Smallest blob that could be a tile, in board pixels. */
  minArea?: number;
  /** Largest, as a fraction of the board. */
  maxAreaFraction?: number;
  /** A tile is convex and solid: its blob fills most of its bounding box. */
  minFill?: number;
  /** Bounding-box aspect ratio bounds. Rotated square tiles reach about 1.4. */
  maxAspect?: number;
  /** Reject matches whose margin over the runner-up is below this. */
  minMargin?: number;
  /** Reject matches whose absolute agreement is below this. */
  minScore?: number;
  /**
   * Where to take the glyph crop from.
   *
   * Given one, crops come from the camera at native resolution, which is the
   * difference between a readable letter and ten pixels of mush. Without one,
   * the board buffer is used — enough for the tests, and the honest fallback
   * when there is no video to sample.
   */
  source?: CropSource;
}

/** Oversampling factor for the crop, so normalisation has detail to work with. */
const CROP = GLYPH_SIZE * 2;

export function detectTiles(
  frame: RectifiedFrame,
  blobs: Blob[],
  atlas: GlyphAtlas,
  opts: TileOptions = {},
): Tile[] {
  const minArea = opts.minArea ?? 120;
  const maxArea = (opts.maxAreaFraction ?? 0.15) * frame.size.w * frame.size.h;
  const minFill = opts.minFill ?? 0.55;
  const maxAspect = opts.maxAspect ?? 1.6;
  const minMargin = opts.minMargin ?? 0.08;
  const minScore = opts.minScore ?? 0.42;

  const crop = new Uint8ClampedArray(CROP * CROP);
  const out: Tile[] = [];

  for (const blob of blobs) {
    if (tileCandidate(blob, { minArea, maxArea, minFill, maxAspect }) !== "ok") continue;

    // Rotate the sampling window by the blob's axis folded into +-45 degrees.
    // Beyond that a square tile is indistinguishable from itself, and the four
    // quarter turns are handled by the matcher.
    const side = Math.sqrt(blob.area) * 1.05;
    const angle = foldAngle(blob.angle);
    if (!opts.source?.sample(blob.cx, blob.cy, side, angle, crop, CROP)) {
      sampleUpright(frame, blob.cx, blob.cy, side, angle, crop, CROP);
    }

    const match = matchGlyph(normaliseGlyph(crop, CROP, CROP), atlas);
    if (!match || match.score < minScore || match.margin < minMargin) continue;

    const ink = meanInk(frame, blob);
    out.push({
      ...match,
      blobId: blob.id,
      cx: blob.cx,
      cy: blob.cy,
      size: side,
      ...ink,
    });
  }

  return out;
}

/** Fold an angle into [-45, 45) degrees, expressed in radians. */
/** Why a blob is not a tile, or "ok" if it might be one. */
export type TileVerdict = "ok" | "too-small" | "too-large" | "not-square" | "not-solid";

export interface CandidateLimits {
  minArea: number;
  maxArea: number;
  minFill: number;
  maxAspect: number;
}

/**
 * Does this blob look like a tile at all?
 *
 * Split out of detectTiles so it can be measured. When tiles are not read,
 * there are two very different causes — the crop was never taken, or it was
 * taken and misread — and they call for completely different work. A filter
 * buried in a loop can only be guessed at; one that names its verdict can be
 * pointed at a real capture and asked.
 */
export function tileCandidate(blob: Blob, limits: CandidateLimits): TileVerdict {
  if (blob.area < limits.minArea) return "too-small";
  if (blob.area > limits.maxArea) return "too-large";

  const bw = blob.maxX - blob.minX + 1;
  const bh = blob.maxY - blob.minY + 1;
  if (Math.max(bw / bh, bh / bw) > limits.maxAspect) return "not-square";
  // A tile is convex and solid: its blob fills most of its bounding box. A
  // grid of tiles printed edge to edge merges into one ragged region and fails
  // here, which is the honest answer — that is not one tile.
  if (blob.area / (bw * bh) < limits.minFill) return "not-solid";

  return "ok";
}

export function foldAngle(angle: number): number {
  const quarter = Math.PI / 2;
  let a = angle % quarter;
  if (a >= quarter / 2) a -= quarter;
  if (a < -quarter / 2) a += quarter;
  return a;
}

/** Sample a rotated square window of the luma plane into a fixed-size buffer. */
function sampleUpright(
  frame: RectifiedFrame,
  cx: number,
  cy: number,
  side: number,
  angle: number,
  out: Uint8ClampedArray,
  outSize: number,
): void {
  const { w, h } = frame.size;
  const gray = frame.gray;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const step = side / outSize;

  for (let y = 0; y < outSize; y++) {
    const ly = (y - outSize / 2 + 0.5) * step;
    for (let x = 0; x < outSize; x++) {
      const lx = (x - outSize / 2 + 0.5) * step;
      const sx = Math.round(cx + lx * cos - ly * sin);
      const sy = Math.round(cy + lx * sin + ly * cos);
      // Outside the board reads as paper-white rather than black, so the tile
      // border never looks like ink to the normaliser.
      out[y * outSize + x] = sx < 0 || sy < 0 || sx >= w || sy >= h ? 255 : gray[sy * w + sx];
    }
  }
}

/** Mean colour of the darker half of the blob — the printed glyph, not the tile stock. */
function meanInk(frame: RectifiedFrame, blob: Blob): { r: number; g: number; b: number } {
  const { w } = frame.size;
  let sum = 0;
  let n = 0;
  for (let y = blob.minY; y <= blob.maxY; y++) {
    for (let x = blob.minX; x <= blob.maxX; x++) {
      sum += frame.gray[y * w + x];
      n++;
    }
  }
  const mid = n ? sum / n : 128;

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = blob.minY; y <= blob.maxY; y++) {
    for (let x = blob.minX; x <= blob.maxX; x++) {
      const i = y * w + x;
      if (frame.gray[i] >= mid) continue;
      const o = i * 4;
      r += frame.rgba[o];
      g += frame.rgba[o + 1];
      b += frame.rgba[o + 2];
      count++;
    }
  }

  return count ? { r: r / count, g: g / count, b: b / count } : { r: blob.r, g: blob.g, b: blob.b };
}
