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
 * reference's exposure. One gain per channel handles both effects: exposure
 * moves all three together, white balance moves them apart.
 *
 * The estimate has to survive a table with things on it, which is the whole
 * point, so it uses medians rather than means. A median is unmoved until more
 * than half the sampled pixels change — and the play area is rarely more than
 * half covered. A mean would be dragged by the first dark object placed, which
 * is exactly the case this exists to handle.
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
   * Channels whose reference median is darker than this are left uncorrected.
   * A ratio between two near-black values is noise amplified, not a gain.
   */
  floor?: number;
  /** Reusable histograms, six of them, so the per-frame path allocates nothing. */
  scratch?: Int32Array[];
}

/** Six 256-bin histograms: current and reference, three channels each. */
export function createGainScratch(): Int32Array[] {
  return Array.from({ length: 6 }, () => new Int32Array(256));
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
  // One sample in six is plenty for a median: the estimate is a summary
  // statistic over tens of thousands of pixels, and halving the sample count
  // moves it by far less than the noise it is measuring.
  const stride = Math.max(1, opts.stride ?? 6);
  const min = opts.min ?? 0.4;
  const max = opts.max ?? 2.5;
  const floor = opts.floor ?? 8;

  const hist = opts.scratch ?? createGainScratch();
  for (const h of hist) h.fill(0);
  const curHist = hist;
  const refHist = [hist[3], hist[4], hist[5]];
  let n = 0;

  const wanted = Math.max(1, Math.floor(pixels / stride));
  for (let k = 0; k < wanted; k++) {
    const i = (k * WALK) % pixels;
    const c = i * 4;
    const r = i * 3;
    curHist[0][current[c]]++;
    curHist[1][current[c + 1]]++;
    curHist[2][current[c + 2]]++;
    // Rounded and clamped inline: Math.round is a call, and this runs six
    // times per sample on the per-frame path.
    let v = (reference[r] + 0.5) | 0;
    refHist[0][v < 0 ? 0 : v > 255 ? 255 : v]++;
    v = (reference[r + 1] + 0.5) | 0;
    refHist[1][v < 0 ? 0 : v > 255 ? 255 : v]++;
    v = (reference[r + 2] + 0.5) | 0;
    refHist[2][v < 0 ? 0 : v > 255 ? 255 : v]++;
    n++;
  }

  if (n === 0) return { ...IDENTITY_GAIN };

  const gains: number[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const cur = median(curHist[ch], n);
    const ref = median(refHist[ch], n);
    if (cur < floor || ref < floor) {
      gains.push(1);
      continue;
    }
    gains.push(Math.min(max, Math.max(min, ref / cur)));
  }

  return { r: gains[0], g: gains[1], b: gains[2] };
}

/** Median from a histogram, without materialising the samples. */
function median(hist: Int32Array, n: number): number {
  const half = n / 2;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= half) return v;
  }
  return 255;
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
