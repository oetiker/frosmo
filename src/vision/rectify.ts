/**
 * Rectification: camera frame -> board space.
 *
 * Every detector downstream reads a small, axis-aligned, undistorted image of
 * the play area. Producing it is the one place the homography is applied per
 * pixel, so it is done through a precomputed lookup table: for each board
 * pixel we store the source pixel offset once, and per frame we only gather.
 *
 * The table is rebuilt when calibration or capture resolution changes, which
 * is roughly never during play.
 */

import { applyHomography, type Mat3 } from "./homography.js";

export interface BoardSize {
  w: number;
  h: number;
}

/** A rectified frame: RGBA at board resolution, plus the luma plane detectors use. */
export interface RectifiedFrame {
  readonly size: BoardSize;
  readonly rgba: Uint8ClampedArray;
  readonly gray: Uint8ClampedArray;
  /** Monotonic timestamp of the source video frame, in ms. */
  time: number;
}

export function createRectifiedFrame(size: BoardSize): RectifiedFrame {
  return {
    size,
    rgba: new Uint8ClampedArray(size.w * size.h * 4),
    gray: new Uint8ClampedArray(size.w * size.h),
    time: 0,
  };
}

/**
 * Build the gather table.
 *
 * `boardToCam` maps board space — the unit square — to camera pixels. Board
 * pixel centres are sampled, so the table covers the play area evenly rather
 * than biasing towards one edge. Entries outside the frame are -1 and read as
 * black; that only happens if the calibration quad hangs off the image.
 */
export function buildSampleTable(
  boardToCam: Mat3,
  board: BoardSize,
  srcW: number,
  srcH: number,
): Int32Array {
  const table = new Int32Array(board.w * board.h);
  const p = { x: 0, y: 0 };

  for (let by = 0; by < board.h; by++) {
    const v = (by + 0.5) / board.h;
    for (let bx = 0; bx < board.w; bx++) {
      const u = (bx + 0.5) / board.w;
      applyHomography(boardToCam, u, v, p);
      const sx = Math.round(p.x);
      const sy = Math.round(p.y);
      table[by * board.w + bx] =
        sx < 0 || sy < 0 || sx >= srcW || sy >= srcH ? -1 : (sy * srcW + sx) * 4;
    }
  }

  return table;
}

/**
 * Gather one rectified frame from a captured camera image.
 *
 * Nearest-neighbour on purpose: the board buffer is far smaller than the
 * capture, so we are downsampling, and the detectors that follow all blur or
 * threshold anyway. Bilinear would cost 4x the reads to remove noise that the
 * morphology stage removes for free.
 */
export function rectify(src: Uint8ClampedArray, table: Int32Array, out: RectifiedFrame): void {
  const { rgba, gray } = out;
  const n = table.length;

  for (let i = 0; i < n; i++) {
    const o = table[i];
    const j = i * 4;
    if (o < 0) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = 0;
      rgba[j + 3] = 255;
      gray[i] = 0;
      continue;
    }
    const r = src[o];
    const g = src[o + 1];
    const b = src[o + 2];
    rgba[j] = r;
    rgba[j + 1] = g;
    rgba[j + 2] = b;
    rgba[j + 3] = 255;
    // Rec. 601 luma, integer weights: cheap and stable across the frame rate.
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
  }
}
