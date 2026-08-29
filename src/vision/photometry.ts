/**
 * Cancelling the camera's own adjustments.
 *
 * A tablet camera never holds still photometrically. Auto-exposure and auto
 * white balance react continuously to the scene, so putting a dark object on
 * the table makes the camera brighten *everything* — and a detector that
 * compares absolute pixel values against a stored reference then reports the
 * entire board as changed. That is not a threshold that needs tuning; it is a
 * comparison between two pictures taken under different exposures.
 *
 * So before any pixel is compared, the current frame is scaled back onto the
 * reference's exposure.
 *
 * The estimate has to survive a table with things on it — that is the whole
 * point — including the most natural thing anyone does, which is to put a sheet
 * of paper down. A sheet covers most of the play area, so more than half the
 * pixels change at once, and any estimator built on a median or a mean then
 * describes the sheet rather than the table: it "corrects away" the very object
 * it is supposed to help detect, and dims everything on top of it in the
 * process. That was not a hypothetical; it is what a real capture showed.
 *
 * So the estimate is the **mode** of the per-pixel ratios, not their median.
 * Background pixels all agree on exactly one ratio — the camera's own gain —
 * and pile into one narrow peak, while pixels covered by clutter scatter. The
 * peak therefore wins even when the background is a minority of the frame,
 * which is a property a median cannot have at any threshold.
 *
 * That is still not enough on its own, and it is worth being precise about
 * why. A *uniform* object — a sheet of white paper — does not scatter: it
 * forms its own sharp peak, a bigger one if it covers more of the board. On a
 * perfectly flat table the two readings are not merely hard to separate, they
 * are the same image: "the table got brighter" and "something bright was put
 * on the table" are indistinguishable from one frame of pixels alone.
 *
 * The tie-break therefore comes from outside the photometry: pixels that the
 * detector *already believes* have changed are excluded from the estimate. The
 * previous frame's gain is close enough to mark a newly placed sheet as
 * changed, the gain is then measured on the table that remains, and the sheet
 * stays visible. When too little is left to measure — a genuine exposure step
 * changes everything at once — the estimate falls back to using the whole
 * frame, which is the case the mode already handles.
 */

export interface Gain {
  r: number;
  g: number;
  b: number;
}

export const IDENTITY_GAIN: Gain = { r: 1, g: 1, b: 1 };

/**
 * Step between samples, in pixels, walking the image modulo its size.
 *
 * Prime, and deliberately not a small one. Sampling every nth pixel in scan
 * order aliases with anything laid out on a regular pitch — a row of tiles, a
 * grid of tokens, a striped cloth — and a sampler that lands on the same phase
 * every time can draw its entire sample from the objects rather than the
 * table. Stepping by a prime that is coprime with the pixel count visits the
 * whole image in a scattered order instead, which no spatial period can
 * correlate with.
 */
const WALK = 7919;

export interface GainOptions {
  /** Take one sample per `stride` pixels. The estimate needs a distribution, not every pixel. */
  stride?: number;
  /** Clamp, so a pathological frame cannot blow the correction up. */
  min?: number;
  max?: number;
  /**
   * Samples darker than this, on either side, contribute nothing. A ratio
   * between two near-black values is amplified noise, not a gain.
   */
  floor?: number;
  /** Reusable histograms, so the per-frame path allocates nothing. */
  scratch?: Int32Array[];
  /**
   * The detector's learned luma, its per-pixel thresholds, and the gain used
   * last frame. Given all three, samples that already look changed are left out
   * of the estimate, which is what stops a large uniform object from being
   * measured as an exposure change. Omit them and the estimate uses every
   * sample.
   */
  exclude?: {
    refGray: Float32Array;
    limits: Float32Array;
    previous: Gain;
  };
}

/** One ratio histogram per channel. */
export function createGainScratch(): Int32Array[] {
  return Array.from({ length: 3 }, () => new Int32Array(BINS));
}

/**
 * Per-channel gain mapping `current` onto the learned `reference`.
 *
 * `current` is RGBA at board resolution; `reference` is the RGB triplets the
 * occupancy detector accumulated while learning the empty board.
 */
export function estimateGain(
  current: Uint8ClampedArray,
  reference: Float32Array,
  pixels: number,
  opts: GainOptions = {},
): Gain {
  const stride = Math.max(1, opts.stride ?? 6);
  const min = opts.min ?? 0.4;
  const max = opts.max ?? 2.5;
  const floor = opts.floor ?? 8;

  const hist = opts.scratch ?? createGainScratch();
  const scale = BINS / (max - min);
  const wanted = Math.max(1, Math.floor(pixels / stride));
  const counted = [0, 0, 0];

  const gather = (skipChanged: boolean) => {
    for (const h of hist) h.fill(0);
    counted[0] = counted[1] = counted[2] = 0;

    const ex = skipChanged ? opts.exclude : undefined;
    const kr = ex ? (ex.previous.r * 77) / 256 : 0;
    const kg = ex ? (ex.previous.g * 150) / 256 : 0;
    const kb = ex ? (ex.previous.b * 29) / 256 : 0;

    for (let k = 0; k < wanted; k++) {
      const i = (k * WALK) % pixels;
      const c = i * 4;

      if (ex) {
        const luma = current[c] * kr + current[c + 1] * kg + current[c + 2] * kb;
        const diff = luma - ex.refGray[i];
        if ((diff < 0 ? -diff : diff) > ex.limits[i]) continue;
      }

      const r = i * 3;
      for (let ch = 0; ch < 3; ch++) {
        const ref = reference[r + ch];
        const cur = current[c + ch];
        // A ratio between two near-black values is amplified noise, not a gain.
        if (ref < floor || cur < floor) continue;
        const ratio = ref / cur;
        if (ratio < min || ratio >= max) continue;
        hist[ch][((ratio - min) * scale) | 0]++;
        counted[ch]++;
      }
    }
  };

  gather(true);
  // Too little of the board still resembles the reference to measure against.
  // That is what a genuine exposure step looks like, so measure the whole frame
  // and let the mode pick out the population that agrees.
  if (opts.exclude && counted[1] < wanted * 0.1) gather(false);

  const gains: number[] = [];
  for (let ch = 0; ch < 3; ch++) {
    gains.push(mode(hist[ch], counted[ch], min, max));
  }

  return { r: gains[0], g: gains[1], b: gains[2] };
}

/** Bins across the permitted ratio range; ~1.6% resolution at unity gain. */
const BINS = 128;

/**
 * The ratio the most pixels agree on.
 *
 * The peak is found over three adjacent bins rather than one, so a peak that
 * straddles a bin boundary is not split in half and beaten by a lesser one, and
 * the result is interpolated across those same three bins to recover a value
 * finer than the bin width.
 *
 * A peak that is not meaningfully taller than the background chatter means
 * there was no agreeing population to find — nothing recognisable as the table
 * is in view — and unity is the honest answer.
 */
function mode(hist: Int32Array, samples: number, min: number, max: number): number {
  if (samples < 64) return 1;

  let bestBin = -1;
  let bestWeight = 0;
  for (let b = 0; b < BINS; b++) {
    const weight =
      (b > 0 ? hist[b - 1] : 0) + hist[b] + (b < BINS - 1 ? hist[b + 1] : 0);
    if (weight > bestWeight) {
      bestWeight = weight;
      bestBin = b;
    }
  }

  // Three bins out of 128 holding less than a twentieth of the samples is a
  // flat distribution, not a peak.
  if (bestBin < 0 || bestWeight < samples * 0.05) return 1;

  const lo = bestBin > 0 ? hist[bestBin - 1] : 0;
  const mid = hist[bestBin];
  const hi = bestBin < BINS - 1 ? hist[bestBin + 1] : 0;
  const total = lo + mid + hi;
  const centroid = total > 0 ? bestBin + (hi - lo) / total : bestBin;

  const width = (max - min) / BINS;
  return min + (centroid + 0.5) * width;
}

/** How far a gain is from doing nothing — the number the vision lab reports. */
export function gainMagnitude(gain: Gain): number {
  return Math.max(
    Math.abs(gain.r - 1),
    Math.abs(gain.g - 1),
    Math.abs(gain.b - 1),
  );
}

export function describeGain(gain: Gain): string {
  return `${gain.r.toFixed(2)} ${gain.g.toFixed(2)} ${gain.b.toFixed(2)}`;
}
