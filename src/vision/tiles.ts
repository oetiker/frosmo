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
  /** Overrides for what counts as a glyph-shaped blob. */
  limits?: Partial<GlyphLimits>;
  /** Reject matches whose margin over the runner-up is below this. */
  minMargin?: number;
  /** Reject matches whose absolute agreement is below this. */
  minScore?: number;
  /** Where to take crops from; falls back to the rectified board. */
  source?: CropSource;
  /** Rotation to correct for, in radians. Zero unless the whole board is askew. */
  angle?: number;
  /** How much better a sideways reading must be to beat an upright one. */
  rotationPenalty?: number;
}

/** Oversampling factor for the crop, so normalisation has detail to work with. */
const CROP = GLYPH_SIZE * 2;

export function detectTiles(
  frame: RectifiedFrame,
  blobs: Blob[],
  atlas: GlyphAtlas,
  opts: TileOptions = {},
): Tile[] {
  const limits: GlyphLimits = { ...glyphLimits(frame.size.w, frame.size.h), ...opts.limits };
  const minMargin = opts.minMargin ?? 0.08;
  const minScore = opts.minScore ?? 0.42;

  const crop = new Uint8ClampedArray(CROP * CROP);
  const out: Tile[] = [];

  for (const blob of blobs) {
    if (glyphCandidate(blob, limits) !== "ok") continue;

    // The window is sized from the bounding box, not from sqrt(area): a glyph
    // is a stroke, not a filled square, and an "I" has a fraction of the area
    // of an "M" at the same height. Sizing by area would crop it to a sliver.
    const bw = blob.maxX - blob.minX + 1;
    const bh = blob.maxY - blob.minY + 1;
    const side = Math.max(bw, bh) * 1.3;

    // Deliberately not rotated to the blob's own principal axis.
    //
    // That was right when the blob was a tile's body: a square's axis says
    // which way the tile is lying. It is quite wrong for a glyph, whose axis is
    // a property of the letter rather than of how it was placed — the principal
    // axis of an "L" runs diagonally, so deskewing by it turns an upright "L"
    // into a diagonal smear that matches nothing. Letters on a sheet are
    // upright, and the matcher tries all four quarter turns for one that is
    // not, which covers a tile placed sideways without inventing a rotation
    // from the letterform.
    const angle = opts.angle ?? 0;
    if (!opts.source?.sample(blob.cx, blob.cy, side, angle, crop, CROP)) {
      sampleUpright(frame, blob.cx, blob.cy, side, angle, crop, CROP);
    }

    const match = matchGlyph(normaliseGlyph(crop, CROP, CROP), atlas, {
      rotationPenalty: opts.rotationPenalty,
    });
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
/** Why a blob is not a glyph, or "ok" if it might be one. */
export type GlyphVerdict = "ok" | "too-small" | "too-large" | "wrong-shape" | "hollow";

export interface GlyphLimits {
  minArea: number;
  maxArea: number;
  /** Fraction of its bounding box the blob must fill. */
  minFill: number;
  /** Width divided by height. Letters are square or taller than wide. */
  minAspect: number;
  maxAspect: number;
  minHeight: number;
  maxHeight: number;
}

/**
 * Limits for a printed glyph, as a fraction of the board.
 *
 * Measured from a real capture: on a 320x240 board covering a sheet of A4, the
 * letters came out 12 to 205 pixels in area, 5 to 25 tall, filling a third to
 * three quarters of their bounding box. Those numbers are stored here as
 * fractions rather than pixels, because the same sheet on a 192-wide board has
 * letters a third the area — an absolute threshold would be right for exactly
 * one board size.
 *
 * A tile's printed border, by contrast, is a large hollow ring — 87x40 filling
 * 0.12 — and so is the edge of a colour disc. Both reject themselves on shape
 * alone, without having to be recognised first.
 */
export function glyphLimits(boardW: number, boardH: number): GlyphLimits {
  const area = boardW * boardH;
  return {
    minArea: Math.max(8, area * 0.00016),
    maxArea: area * 0.0055,
    minFill: 0.28,
    minAspect: 0.25,
    maxAspect: 1.6,
    minHeight: Math.max(4, boardH * 0.02),
    maxHeight: boardH * 0.17,
  };
}

/** The limits for the board the capture was measured on, for tests and defaults. */
export const GLYPH_LIMITS: GlyphLimits = glyphLimits(320, 240);

/**
 * Does this blob of ink look like a letter?
 *
 * The question deliberately asks nothing about tiles. A printed tile on a white
 * sheet is not an object sitting on the table — its border is ink like any
 * other, and the sheet it is printed on is the surface. Looking for tiles in
 * the occupancy layer found none, and handed the recogniser the colour discs
 * instead, which is why every tile read as "M": the densest template in the
 * atlas is the best match for a solid circle.
 *
 * So this looks for letter-shaped ink and ignores every other form. That works
 * for an uncut sheet, for tiles cut out and scattered on a table, and for
 * letters written by hand.
 */
export function glyphCandidate(blob: Blob, limits: GlyphLimits = GLYPH_LIMITS): GlyphVerdict {
  if (blob.area < limits.minArea) return "too-small";
  if (blob.area > limits.maxArea) return "too-large";

  const bw = blob.maxX - blob.minX + 1;
  const bh = blob.maxY - blob.minY + 1;
  if (bh < limits.minHeight || bh > limits.maxHeight) return "wrong-shape";

  const aspect = bw / bh;
  if (aspect < limits.minAspect || aspect > limits.maxAspect) return "wrong-shape";

  // The test that does the real work: a letter is a solid mark, a border or a
  // disc's edge is a ring around a large empty box.
  if (blob.area / (bw * bh) < limits.minFill) return "hollow";

  return "ok";
}

/** The smallest ink blob worth labelling, for a board of this size. */
export function glyphMinArea(boardW: number, boardH: number): number {
  return Math.round(glyphLimits(boardW, boardH).minArea);
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
