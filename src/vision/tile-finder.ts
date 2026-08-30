/**
 * Finding the tiles, rather than the ink on them.
 *
 * The pipeline used to hand the recogniser every blob of ink and ask of each
 * one "are you a letter?". That question cannot be answered on a real sheet.
 * A piece of a tile's printed border is glyph-sized and glyph-shaped, and an
 * upright fragment of one is the same bitmap as a letter I once the crop is
 * normalised — so the recogniser was being asked to separate two things that
 * are not different. It needs a reject class just to cope, and even then the
 * uprights get through.
 *
 * Asking a different question removes the problem instead of managing it:
 * *where are the tiles*, and then, what is inside this one. Nothing outside a
 * tile is ever a candidate, so the border cannot compete with the letter it
 * surrounds — it is the thing that located it.
 *
 * It also fixes umlauts, which the blob path cannot. The two dots of an Ä are
 * not connected to the A beneath them: a blob finder returns three components,
 * drops the dots for being too small, and hands over a perfectly confident A.
 * Inside a tile there is no such question — everything in the tile is the
 * glyph, dots included.
 *
 * The frame is what makes a tile findable. In the ink mask it is a closed loop
 * of lit pixels, so the tile's interior is a hole: an unlit region, enclosed,
 * roughly square, of a size the board size predicts. Label the inverse of the
 * ink mask and the tiles fall out. Printed frames come out of a threshold
 * broken rather than closed, so the mask is dilated first to seal the gaps —
 * that costs a few pixels of interior, which the result gives back.
 */

import { labelBlobs, type LabelScratch } from "./blobs.js";
import { createMask, dilate, type Mask } from "./mask.js";

export interface Tile {
  /** Centre of the interior — of the box, not of the ink in it. */
  cx: number;
  cy: number;
  /** The interior, in board pixels, up to the inner edge of the frame. */
  w: number;
  h: number;
}

/**
 * How much of the interior to read.
 *
 * Just inside it. The glyph has to arrive without any of its frame: the
 * normaliser thresholds the crop and takes the bounding box of everything dark
 * in it, so one pixel of frame in the corner turns the whole tile into the
 * glyph and the letter shrinks to nothing inside it.
 */
export const INTERIOR = 0.88;

export interface TileFinderOptions {
  /** Rounds of dilation used to close the gaps in a printed frame. */
  seal?: number;
  /** Interior size limits, as a fraction of the board's smaller side. */
  minSide?: number;
  maxSide?: number;
  scratch?: LabelScratch;
}

export class TileFinder {
  private readonly sealed: Mask;
  private readonly holes: Mask;
  private readonly buffer: Uint8Array;

  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {
    this.sealed = createMask(w, h);
    this.holes = createMask(w, h);
    this.buffer = new Uint8Array(w * h);
  }

  find(ink: Mask, opts: TileFinderOptions = {}): Tile[] {
    const { w, h } = this;
    const seal = opts.seal ?? 3;
    const short = Math.min(w, h);
    const minSide = (opts.minSide ?? 0.07) * short;
    const maxSide = (opts.maxSide ?? 0.3) * short;

    this.sealed.data.set(ink.data);
    for (let i = 0; i < seal; i++) dilate(this.sealed, this.buffer);
    for (let i = 0; i < w * h; i++) this.holes.data[i] = this.sealed.data[i] ? 0 : 1;

    const { blobs } = labelBlobs(this.holes, {
      minArea: minSide * minSide * 0.25,
      maxAreaFraction: 0.25,
      limit: 128,
      scratch: opts.scratch,
    });

    const tiles: Tile[] = [];
    for (const b of blobs) {
      // Give back what the dilation took, so the interior is the whole tile
      // again and a glyph touching its frame is not clipped.
      // Give back what the dilation took, so the box is the interior again.
      const bw = b.maxX - b.minX + 1 + seal * 2;
      const bh = b.maxY - b.minY + 1 + seal * 2;
      if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide) continue;
      // Tiles are square-ish. Perspective stretches them, but not far.
      const aspect = bw / bh;
      if (aspect < 0.55 || aspect > 1.8) continue;
      // The centre of the box, not the centroid of the hole: the glyph sits in
      // the hole and drags its centroid towards whichever side it is heavier on.
      tiles.push({
        cx: (b.minX + b.maxX) / 2,
        cy: (b.minY + b.maxY) / 2,
        w: bw,
        h: bh,
      });
    }
    return tiles;
  }
}
