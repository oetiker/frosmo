/**
 * Sampling a small region of the camera frame at its native resolution.
 *
 * The pipeline deliberately works on a small rectified board: it is the right
 * size for deciding *where* things are, and making it bigger would cost every
 * stage. Reading a printed letter is the one job that needs more than that, and
 * a real capture showed exactly how much more. In the raw 1280x720 frame a
 * glyph is around 35 pixels tall — ample. By the time it reaches the board
 * buffer it is about ten, and every tile matches "M", the densest template in
 * the atlas, because there is nothing left to tell them apart.
 *
 * The detail was never missing, only discarded. So candidates are found on the
 * cheap board buffer, and each one is then re-sampled from the video element at
 * full resolution: the browser crops on the GPU and only a few thousand pixels
 * per tile come back to the CPU.
 */

import { applyHomography, type Mat3 } from "./homography.js";

export interface CropSource {
  /**
   * Fill `out` with an upright, `outSize` square view of the tile at (cx, cy)
   * in board pixels. Returns false when the region cannot be sampled.
   */
  sample(
    cx: number,
    cy: number,
    side: number,
    angle: number,
    out: Uint8ClampedArray,
    outSize: number,
  ): boolean;
}

/** Never read back more than this per tile; a tile filling the board is not a tile. */
const MAX_CROP = 256;

export class VideoCropSource implements CropSource {
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  /**
   * @param video        the running camera element
   * @param boardToCam   board unit square to *native* camera pixels
   * @param board        board buffer dimensions, to convert pixels to units
   */
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly boardToCam: Mat3,
    private readonly board: { w: number; h: number },
  ) {}

  sample(
    cx: number,
    cy: number,
    side: number,
    angle: number,
    out: Uint8ClampedArray,
    outSize: number,
  ): boolean {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return false;

    // The tile's four corners, in board pixels, rotated upright.
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const half = side / 2;
    const corners: Array<{ x: number; y: number }> = [];
    for (const [dx, dy] of [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ]) {
      corners.push(this.toCamera(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos));
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    // A margin, because the blob's bounding square is an estimate and clipping
    // the glyph is far more damaging than including a little of the table.
    const pad = 3;
    const bx = Math.max(0, Math.floor(minX) - pad);
    const by = Math.max(0, Math.floor(minY) - pad);
    const bw = Math.min(vw - bx, Math.ceil(maxX - minX) + pad * 2);
    const bh = Math.min(vh - by, Math.ceil(maxY - minY) + pad * 2);
    if (bw < 4 || bh < 4 || bw > MAX_CROP || bh > MAX_CROP) return false;

    const ctx = this.context(bw, bh);
    if (!ctx) return false;
    ctx.drawImage(this.video, bx, by, bw, bh, 0, 0, bw, bh);
    const { data } = ctx.getImageData(0, 0, bw, bh);

    // Walk the upright output square, mapping each pixel back through the same
    // geometry, so rotation and the play area's perspective are both undone.
    const step = side / outSize;
    for (let y = 0; y < outSize; y++) {
      const ly = (y - outSize / 2 + 0.5) * step;
      for (let x = 0; x < outSize; x++) {
        const lx = (x - outSize / 2 + 0.5) * step;
        const p = this.toCamera(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
        const sx = Math.round(p.x) - bx;
        const sy = Math.round(p.y) - by;
        if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) {
          // Outside reads as paper-white, never black: a dark border would look
          // like ink to the glyph normaliser.
          out[y * outSize + x] = 255;
          continue;
        }
        const o = (sy * bw + sx) * 4;
        out[y * outSize + x] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
      }
    }

    return true;
  }

  /** Board pixels to native camera pixels. */
  private toCamera(x: number, y: number): { x: number; y: number } {
    return applyHomography(this.boardToCam, (x + 0.5) / this.board.w, (y + 0.5) / this.board.h);
  }

  private context(w: number, h: number): CanvasRenderingContext2D | null {
    if (!this.canvas) {
      this.canvas =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(w, h)
          : document.createElement("canvas");
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx = null;
    }
    if (!this.ctx) {
      this.ctx = this.canvas.getContext("2d", {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D | null;
    }
    return this.ctx;
  }
}
