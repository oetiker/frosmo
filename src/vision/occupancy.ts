/**
 * "What is on the table" — background subtraction in board space.
 *
 * The play surface is static and the camera is bolted to the iPad, so a plain
 * reference-frame model beats anything adaptive-per-pixel: it reacts instantly,
 * costs one subtraction per pixel, and never learns a piece into the background
 * because a child left it there for a minute.
 *
 * Two refinements earn their keep:
 *   - shadow rejection, because a hand reaching in throws a shadow twice its
 *     own size and a naive threshold treats that shadow as an object;
 *   - slow drift correction, because the room lights and the iPad's own
 *     auto-exposure move the whole frame over a few minutes.
 */

import { createMask, open, type Mask } from "./mask.js";
import type { RectifiedFrame } from "./rectify.js";

export interface OccupancyOptions {
  /** Luma difference, 0-255, at which a pixel counts as covered. */
  threshold?: number;
  /** Rounds of open() applied to the raw difference. */
  denoise?: number;
  /** Per-frame weight for drift correction of background pixels. 0 disables it. */
  drift?: number;
  /** Reject darker-but-same-colour pixels as shadow. */
  rejectShadows?: boolean;
}

export class OccupancyDetector {
  readonly mask: Mask;
  private readonly bgGray: Float32Array;
  private readonly bgRgb: Float32Array;
  private readonly scratch: Uint8Array;
  private samples = 0;
  private opts: Required<OccupancyOptions>;

  constructor(
    private readonly w: number,
    private readonly h: number,
    opts: OccupancyOptions = {},
  ) {
    this.mask = createMask(w, h);
    this.bgGray = new Float32Array(w * h);
    this.bgRgb = new Float32Array(w * h * 3);
    this.scratch = new Uint8Array(w * h);
    this.opts = {
      threshold: opts.threshold ?? 26,
      denoise: opts.denoise ?? 1,
      drift: opts.drift ?? 0.01,
      rejectShadows: opts.rejectShadows ?? true,
    };
  }

  configure(opts: OccupancyOptions): void {
    this.opts = { ...this.opts, ...opts };
  }

  get calibrated(): boolean {
    return this.samples > 0;
  }

  /** Reset the reference; the next learn() calls start a fresh average. */
  forget(): void {
    this.samples = 0;
    this.bgGray.fill(0);
    this.bgRgb.fill(0);
  }

  /**
   * Fold one empty-board frame into the reference.
   *
   * Averaging several frames rather than snapshotting one matters more than it
   * looks: a single frame carries the sensor noise of that instant into every
   * later difference, and that noise is the same order as the threshold.
   */
  learn(frame: RectifiedFrame): void {
    const n = ++this.samples;
    const k = 1 / n;
    const { gray, rgba } = frame;
    for (let i = 0; i < gray.length; i++) {
      this.bgGray[i] += (gray[i] - this.bgGray[i]) * k;
      const o = i * 3;
      const j = i * 4;
      this.bgRgb[o] += (rgba[j] - this.bgRgb[o]) * k;
      this.bgRgb[o + 1] += (rgba[j + 1] - this.bgRgb[o + 1]) * k;
      this.bgRgb[o + 2] += (rgba[j + 2] - this.bgRgb[o + 2]) * k;
    }
  }

  /** Update the mask from the current frame. Returns the covered pixel count. */
  detect(frame: RectifiedFrame): number {
    if (!this.calibrated) return 0;

    const { threshold, denoise, drift, rejectShadows } = this.opts;
    const { gray, rgba } = frame;
    const m = this.mask.data;
    let count = 0;

    for (let i = 0; i < gray.length; i++) {
      const bg = this.bgGray[i];
      const cur = gray[i];
      const diff = cur - bg;
      let fg = Math.abs(diff) > threshold ? 1 : 0;

      if (fg && rejectShadows && diff < 0 && cur > bg * 0.35) {
        // A shadow scales all three channels roughly equally, so the hue is
        // preserved and only the brightness drops. Compare chromaticity — the
        // colour with brightness divided out — and drop the pixel if it matches
        // the background's.
        const o = i * 3;
        const j = i * 4;
        if (chromaDistance(rgba[j], rgba[j + 1], rgba[j + 2], this.bgRgb[o], this.bgRgb[o + 1], this.bgRgb[o + 2]) < 0.06) {
          fg = 0;
        }
      }

      m[i] = fg;
      count += fg;

      if (!fg && drift > 0) {
        this.bgGray[i] += (cur - this.bgGray[i]) * drift;
        const o = i * 3;
        const j = i * 4;
        this.bgRgb[o] += (rgba[j] - this.bgRgb[o]) * drift;
        this.bgRgb[o + 1] += (rgba[j + 1] - this.bgRgb[o + 1]) * drift;
        this.bgRgb[o + 2] += (rgba[j + 2] - this.bgRgb[o + 2]) * drift;
      }
    }

    if (denoise > 0) open(this.mask, this.scratch, denoise);
    return count;
  }

  /** The learned reference, as RGBA for the debug view. */
  backgroundRgba(out: Uint8ClampedArray): void {
    for (let i = 0; i < this.w * this.h; i++) {
      const o = i * 3;
      const j = i * 4;
      out[j] = this.bgRgb[o];
      out[j + 1] = this.bgRgb[o + 1];
      out[j + 2] = this.bgRgb[o + 2];
      out[j + 3] = 255;
    }
  }
}

/** Distance between two colours after dividing brightness out. */
export function chromaDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const s1 = r1 + g1 + b1 || 1;
  const s2 = r2 + g2 + b2 || 1;
  const dr = r1 / s1 - r2 / s2;
  const dg = g1 / s1 - g2 / s2;
  const db = b1 / s1 - b2 / s2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
