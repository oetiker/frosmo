/**
 * "What is on the table" — background subtraction in board space.
 *
 * The play surface is static and the camera is bolted to the tablet, so a
 * reference model of the empty board beats anything adaptive-per-pixel: it
 * reacts instantly and never learns a piece into the background because a child
 * left it there for a minute.
 *
 * What that model has to survive, and what each part below is for:
 *
 *   - **The camera adjusts itself.** Auto-exposure and white balance react to
 *     the scene, so a dark object placed on the table brightens the whole
 *     frame. Compared against a stored reference, every pixel then differs.
 *     Every frame is scaled back onto the reference's exposure before anything
 *     is compared. This is the single most important step; without it the
 *     detector reports the whole board as covered whenever the light shifts.
 *   - **Noise is not uniform.** Under a mirror the image is dim, the sensor
 *     gain is high, and the noise differs across the frame. The reference
 *     therefore learns a per-pixel standard deviation as well as a mean, and
 *     the threshold is per-pixel: a multiple of that pixel's own noise, with an
 *     absolute floor.
 *   - **Hands cast shadows.** A shadow scales all three channels together, so
 *     comparing colour with brightness divided out rejects it while keeping
 *     genuinely dark objects.
 */

import { createMask, open, type Mask } from "./mask.js";
import { createGainScratch, estimateGain, IDENTITY_GAIN, type Gain } from "./photometry.js";
import type { RectifiedFrame } from "./rectify.js";

export interface OccupancyOptions {
  /**
   * Absolute luma difference below which nothing counts as covered, whatever
   * the noise model says. Guards against a suspiciously quiet reference.
   */
  threshold?: number;
  /**
   * Multiple of a pixel's own learned noise it must exceed. Raise it if the
   * board flickers with detections; lower it if pale pieces go unseen.
   */
  noiseFactor?: number;
  /** Rounds of open() applied to the raw difference. */
  denoise?: number;
  /** Per-frame weight for drift correction of background pixels. 0 disables it. */
  drift?: number;
  /** Apply drift correction every N frames. Lighting moves over minutes. */
  driftEvery?: number;
  /** Reject darker-but-same-colour pixels as shadow. */
  rejectShadows?: boolean;
  /** Scale each frame onto the reference's exposure before comparing. */
  normaliseExposure?: boolean;
}

/** Above this covered fraction, sustained, the reference is probably stale. */
const SUSPECT_COVERAGE = 0.8;
const SUSPECT_FRAMES = 45;

export class OccupancyDetector {
  readonly mask: Mask;
  private readonly bgGray: Float32Array;
  private readonly bgRgb: Float32Array;
  /** Welford accumulator for the per-pixel luma variance. */
  private readonly m2: Float32Array;
  private readonly sigma: Float32Array;
  /** Per-pixel difference a covered pixel must exceed; derived from sigma and the options. */
  private readonly limits: Float32Array;
  private readonly scratch: Uint8Array;
  private readonly gainScratch = createGainScratch();
  private samples = 0;
  private frames = 0;
  private sigmaDirty = true;
  private suspectFrames = 0;
  private lastGain: Gain = { ...IDENTITY_GAIN };
  private lastCovered = 0;
  private opts: Required<OccupancyOptions>;

  constructor(
    private readonly w: number,
    private readonly h: number,
    opts: OccupancyOptions = {},
  ) {
    this.mask = createMask(w, h);
    this.bgGray = new Float32Array(w * h);
    this.bgRgb = new Float32Array(w * h * 3);
    this.m2 = new Float32Array(w * h);
    this.sigma = new Float32Array(w * h);
    this.limits = new Float32Array(w * h);
    this.scratch = new Uint8Array(w * h);
    this.opts = {
      threshold: opts.threshold ?? 16,
      noiseFactor: opts.noiseFactor ?? 4,
      denoise: opts.denoise ?? 1,
      drift: opts.drift ?? 0.12,
      driftEvery: opts.driftEvery ?? 12,
      rejectShadows: opts.rejectShadows ?? true,
      normaliseExposure: opts.normaliseExposure ?? true,
    };
  }

  configure(opts: OccupancyOptions): void {
    this.opts = { ...this.opts, ...opts };
    // The thresholds depend on the options, so they are stale now. Recomputing
    // them here keeps the per-frame loop down to one comparison per pixel.
    this.sigmaDirty = true;
  }

  settings(): Required<OccupancyOptions> {
    return { ...this.opts };
  }

  get calibrated(): boolean {
    return this.samples > 0;
  }

  /** The exposure correction applied to the last frame. Near 1.00 means the camera is holding still. */
  get gain(): Gain {
    return this.lastGain;
  }

  get coveredFraction(): number {
    return this.lastCovered / (this.w * this.h);
  }

  /**
   * True when the board has read as almost entirely covered for long enough
   * that the reference, not the table, is the likely problem. Worth saying out
   * loud: the alternative is a player staring at a game that ignores them.
   */
  get suspect(): boolean {
    return this.suspectFrames >= SUSPECT_FRAMES;
  }

  /** Reset the reference; the next learn() calls start a fresh average. */
  forget(): void {
    this.samples = 0;
    this.frames = 0;
    this.suspectFrames = 0;
    this.sigmaDirty = true;
    this.bgGray.fill(0);
    this.bgRgb.fill(0);
    this.m2.fill(0);
    this.sigma.fill(0);
    this.lastGain = { ...IDENTITY_GAIN };
  }

  /**
   * Fold one empty-board frame into the reference.
   *
   * Averaging several frames rather than snapshotting one matters more than it
   * looks: a single frame carries the sensor noise of that instant into every
   * later difference, and that noise is the same order as the threshold.
   * Accumulating the variance at the same time costs one multiply and gives
   * every pixel its own idea of what "different" means.
   */
  learn(frame: RectifiedFrame): void {
    const n = ++this.samples;
    const k = 1 / n;
    const { gray, rgba } = frame;

    for (let i = 0; i < gray.length; i++) {
      // Welford: mean and M2 in one pass, numerically stable over a long learn.
      const x = gray[i];
      const delta = x - this.bgGray[i];
      this.bgGray[i] += delta * k;
      this.m2[i] += delta * (x - this.bgGray[i]);

      const o = i * 3;
      const j = i * 4;
      this.bgRgb[o] += (rgba[j] - this.bgRgb[o]) * k;
      this.bgRgb[o + 1] += (rgba[j + 1] - this.bgRgb[o + 1]) * k;
      this.bgRgb[o + 2] += (rgba[j + 2] - this.bgRgb[o + 2]) * k;
    }

    this.sigmaDirty = true;
  }

  /** Update the mask from the current frame. Returns the covered pixel count. */
  detect(frame: RectifiedFrame): number {
    if (!this.calibrated) return 0;
    if (this.sigmaDirty) this.refreshSigma();

    const { denoise, drift, driftEvery, rejectShadows, normaliseExposure } = this.opts;
    const { gray, rgba } = frame;
    const pixels = gray.length;

    const gain = normaliseExposure
      ? estimateGain(rgba, this.bgRgb, pixels, { scratch: this.gainScratch })
      : { ...IDENTITY_GAIN };
    this.lastGain = gain;

    const applyDrift = drift > 0 && ++this.frames % driftEvery === 0;
    const m = this.mask.data;
    // Hoisted out of the loop: a property load per pixel per array is the
    // difference between this stage costing one millisecond and three.
    const bgGray = this.bgGray;
    const bgRgb = this.bgRgb;
    const limits = this.limits;
    // Fold the channel weights and the gain into three constants, so correcting
    // the exposure costs the same three multiplies the luma already needed.
    const kr = (gain.r * 77) / 256;
    const kg = (gain.g * 150) / 256;
    const kb = (gain.b * 29) / 256;
    let count = 0;

    for (let i = 0; i < pixels; i++) {
      const j = i * 4;
      const r = rgba[j];
      const g = rgba[j + 1];
      const b = rgba[j + 2];
      const cur = r * kr + g * kg + b * kb;

      const bg = bgGray[i];
      const diff = cur - bg;
      const magnitude = diff < 0 ? -diff : diff;
      let fg = magnitude > limits[i] ? 1 : 0;

      if (fg && rejectShadows && diff < 0 && cur > bg * 0.35) {
        // A shadow scales all three channels roughly equally, so hue survives
        // and only brightness drops. Compare chromaticity — colour with
        // brightness divided out — and drop the pixel if it still matches.
        // Only reached for candidate pixels, so the divisions stay off the
        // hot path.
        const o = i * 3;
        if (
          chromaDistance(
            r * gain.r,
            g * gain.g,
            b * gain.b,
            bgRgb[o],
            bgRgb[o + 1],
            bgRgb[o + 2],
          ) < 0.06
        ) {
          fg = 0;
        }
      }

      m[i] = fg;
      count += fg;

      if (!fg && applyDrift) {
        bgGray[i] += (cur - bgGray[i]) * drift;
        const o = i * 3;
        bgRgb[o] += (r * gain.r - bgRgb[o]) * drift;
        bgRgb[o + 1] += (g * gain.g - bgRgb[o + 1]) * drift;
        bgRgb[o + 2] += (b * gain.b - bgRgb[o + 2]) * drift;
      }
    }

    if (denoise > 0) open(this.mask, this.scratch, denoise);

    this.lastCovered = count;
    this.suspectFrames =
      count / pixels > SUSPECT_COVERAGE ? this.suspectFrames + 1 : 0;
    return count;
  }

  /**
   * Standard deviation per pixel, from the Welford accumulator.
   *
   * Floored, because a handful of learn frames can agree exactly on a flat
   * surface and a zero threshold would make that pixel fire on the first bit of
   * noise it ever sees.
   */
  private refreshSigma(): void {
    const n = Math.max(1, this.samples);
    const { threshold, noiseFactor } = this.opts;
    for (let i = 0; i < this.sigma.length; i++) {
      const sigma = Math.max(1.5, Math.sqrt(this.m2[i] / n));
      this.sigma[i] = sigma;
      this.limits[i] = Math.max(threshold, sigma * noiseFactor);
    }
    this.sigmaDirty = false;
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

  /** The learned reference RGB, for detectors that want to divide it out. */
  get reference(): Float32Array {
    return this.bgRgb;
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
