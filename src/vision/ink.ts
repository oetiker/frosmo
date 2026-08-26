/**
 * Ink: dark strokes on light paper.
 *
 * Occupancy answers "is something there"; ink answers "what has been drawn".
 * They need different maths. A drawn line is a small, low-contrast, local
 * change on a sheet that itself may have been nudged since the reference frame
 * was taken, so background subtraction reports the whole sheet. Adaptive
 * thresholding — compare each pixel to the average of its neighbourhood — cares
 * only about local contrast, so it survives the paper moving, the light
 * falling off across the play area, and the mirror's own vignetting.
 */

import { close, createMask, type Mask } from "./mask.js";

export interface InkOptions {
  /** Neighbourhood radius, in board pixels. Roughly the widest gap a stroke may have. */
  radius?: number;
  /** How far below the local mean a pixel must fall, as a fraction of that mean. */
  contrast?: number;
  /** Ignore pixels brighter than this: dark objects are ink, a dark table is not. */
  maxLuma?: number;
  /** Rounds of close() to bridge the gaps a dry pen leaves. */
  bridge?: number;
}

export class InkDetector {
  readonly mask: Mask;
  private readonly integral: Float64Array;
  private readonly scratch: Uint8Array;
  private readonly iw: number;
  private opts: Required<InkOptions>;

  constructor(
    private readonly w: number,
    private readonly h: number,
    opts: InkOptions = {},
  ) {
    this.mask = createMask(w, h);
    this.iw = w + 1;
    this.integral = new Float64Array((w + 1) * (h + 1));
    this.scratch = new Uint8Array(w * h);
    this.opts = {
      radius: opts.radius ?? Math.max(4, Math.round(w / 16)),
      contrast: opts.contrast ?? 0.12,
      maxLuma: opts.maxLuma ?? 210,
      bridge: opts.bridge ?? 1,
    };
  }

  configure(opts: InkOptions): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Update the ink mask from a rectified luma plane. Returns the inked pixel count. */
  detect(gray: Uint8ClampedArray): number {
    const { w, h, iw, integral } = this;
    const { radius, contrast, maxLuma, bridge } = this.opts;

    // Summed-area table: any window mean in constant time, which keeps the
    // radius a free parameter instead of a performance cliff.
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
      }
    }

    const m = this.mask.data;
    let count = 0;

    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w - 1, x + radius);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          integral[(y1 + 1) * iw + (x1 + 1)] -
          integral[y0 * iw + (x1 + 1)] -
          integral[(y1 + 1) * iw + x0] +
          integral[y0 * iw + x0];
        const mean = sum / area;
        const v = gray[y * w + x];
        const inked = v < mean * (1 - contrast) && v < maxLuma ? 1 : 0;
        m[y * w + x] = inked;
        count += inked;
      }
    }

    if (bridge > 0) close(this.mask, this.scratch, bridge);
    return count;
  }
}
