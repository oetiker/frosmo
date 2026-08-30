/**
 * Which blobs of ink might be letters.
 *
 * Only the shape test lives here. Reading the letter is tile-reader.ts, which
 * runs the trained recogniser; the template matcher this file used to hold was
 * removed when that replaced it, rather than left behind to rot.
 */

import type { Blob } from "./blobs.js";

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

