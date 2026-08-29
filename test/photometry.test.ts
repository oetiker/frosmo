import { describe, expect, it } from "vitest";
import { describeGain, estimateGain, gainMagnitude } from "../src/vision/photometry.js";

const W = 64;
const H = 48;
const PIXELS = W * H;

/** RGBA frame, painted per pixel. */
function frame(paint: (i: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < PIXELS; i++) {
    const [r, g, b] = paint(i);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Reference RGB triplets, as the occupancy detector stores them. */
function reference(paint: (i: number) => [number, number, number]): Float32Array {
  const out = new Float32Array(PIXELS * 3);
  for (let i = 0; i < PIXELS; i++) {
    const [r, g, b] = paint(i);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

const TABLE: [number, number, number] = [180, 174, 166];

describe("estimateGain", () => {
  it("is identity when nothing has changed", () => {
    const gain = estimateGain(frame(() => TABLE), reference(() => TABLE), PIXELS);
    expect(gain.r).toBeCloseTo(1, 1);
    expect(gain.g).toBeCloseTo(1, 1);
    expect(gain.b).toBeCloseTo(1, 1);
    expect(gainMagnitude(gain)).toBeLessThan(0.05);
  });

  it("recovers an exposure change", () => {
    // The camera stopped down by a fifth; the gain has to put it back.
    const darker = frame(() => TABLE.map((c) => Math.round(c * 0.8)) as [number, number, number]);
    const gain = estimateGain(darker, reference(() => TABLE), PIXELS);
    expect(gain.r).toBeCloseTo(1.25, 1);
    expect(gain.g).toBeCloseTo(1.25, 1);
    expect(gain.b).toBeCloseTo(1.25, 1);
  });

  it("recovers a white balance shift, per channel", () => {
    // Screen light spilling onto the table pushes blue up and red down.
    const cast = frame(() => [Math.round(TABLE[0] * 0.85), TABLE[1], Math.round(TABLE[2] * 1.15)]);
    const gain = estimateGain(cast, reference(() => TABLE), PIXELS);
    expect(gain.r).toBeGreaterThan(1.1);
    expect(gain.b).toBeLessThan(0.95);
    expect(gain.g).toBeCloseTo(1, 1);
  });

  it("survives a third of the table being covered, laid out on a regular pitch", () => {
    // Two guards in one. Medians: a mean would be dragged down by the objects
    // and then "correct" the empty table into looking covered. And the
    // every-third-pixel layout is deliberate — a sampler stepping in scan
    // order can align with a repeating pattern and draw its whole sample from
    // the objects, which is exactly what a row of tiles on a table looks like.
    const covered = frame((i) =>
      i % 3 === 0 ? [20, 20, 24] : (TABLE.map((c) => Math.round(c * 0.8)) as [number, number, number]),
    );
    const gain = estimateGain(covered, reference(() => TABLE), PIXELS);
    expect(gain.r).toBeCloseTo(1.25, 1);
  });

  it("declines to guess when nothing in view resembles the reference", () => {
    // A ratio outside the permitted range is not a plausible exposure
    // excursion: it means the scene changed, the lights went out, or the
    // reference is stale. Half-correcting that produces a confidently wrong
    // mask; unity plus the detector's own "this board looks wrong" is honest.
    const black = frame(() => [1, 1, 1]);
    const gain = estimateGain(black, reference(() => [250, 250, 250]), PIXELS, { floor: 0 });
    expect(gain).toEqual({ r: 1, g: 1, b: 1 });
  });

  it("leaves near-black channels alone", () => {
    // A ratio between two nearly black values is amplified noise, not a gain.
    const gain = estimateGain(frame(() => [2, 180, 180]), reference(() => [3, 174, 174]), PIXELS);
    expect(gain.r).toBe(1);
    expect(gain.g).not.toBe(1);
  });

  it("honours the range it is given", () => {
    const darker = frame(() => [90, 90, 90]);
    expect(estimateGain(darker, reference(() => [180, 180, 180]), PIXELS, { max: 1.5 })).toEqual({
      r: 1,
      g: 1,
      b: 1,
    });
    // The same frame, with the range widened to admit it.
    expect(
      estimateGain(darker, reference(() => [180, 180, 180]), PIXELS, { max: 2.5 }).r,
    ).toBeCloseTo(2, 1);
  });

  it("outvotes clutter, which scatters rather than agreeing", () => {
    // Half the pixels are junk of every brightness — the ordinary case of
    // things strewn on a table. They spread across every ratio; only the table
    // agrees with itself, so the table decides.
    let seed = 12345;
    const mixed = frame((i) => {
      if (i % 2 === 0) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const v = (seed >>> 20) % 256;
        return [v, v, v];
      }
      return TABLE.map((c) => Math.round(c * 0.8)) as [number, number, number];
    });
    expect(estimateGain(mixed, reference(() => TABLE), PIXELS).r).toBeCloseTo(1.25, 1);
  });

  describe("with a large uniform object in view", () => {
    /**
     * The case a real capture produced: a printed sheet covering most of the
     * board. A uniform object does not scatter — it forms its own sharp peak,
     * a taller one than the table it hides — so the mode alone picks the paper
     * and corrects the sheet away. The detector's own thresholds break the tie.
     */
    const PAPER: [number, number, number] = [236, 234, 230];
    const sheet = (exposure: number) =>
      frame((i) =>
        i % 10 < 7
          ? (PAPER.map((c) => Math.round(c * exposure)) as [number, number, number])
          : (TABLE.map((c) => Math.round(c * exposure)) as [number, number, number]),
      );

    const ref = reference(() => TABLE);
    const refGray = new Float32Array(PIXELS).fill(
      (TABLE[0] * 77 + TABLE[1] * 150 + TABLE[2] * 29) / 256,
    );
    const limits = new Float32Array(PIXELS).fill(16);

    it("is fooled by the sheet with no help from the detector", () => {
      // Documents why the exclusion exists, and fails loudly if it is dropped.
      const gain = estimateGain(sheet(1), ref, PIXELS);
      expect(gain.r).toBeLessThan(0.85);
    });

    it("measures the table the sheet has not covered", () => {
      const gain = estimateGain(sheet(1), ref, PIXELS, {
        exclude: { refGray, limits, previous: { r: 1, g: 1, b: 1 } },
      });
      expect(gain.r).toBeCloseTo(1, 1);
    });

    it("tracks the exposure drifting while the sheet stays put", () => {
      // Auto-exposure ramps over many frames; it does not step. Each frame's
      // estimate feeds the next, which is how the detector uses it.
      let previous = { r: 1, g: 1, b: 1 };
      for (let step = 1; step <= 10; step++) {
        const exposure = 1 - step * 0.02;
        previous = estimateGain(sheet(exposure), ref, PIXELS, {
          exclude: { refGray, limits, previous },
        });
      }
      // Down to 0.8 exposure, so the correction back up is 1/0.8.
      expect(previous.r).toBeCloseTo(1.25, 1);
    });
  });

  it("is identity for an empty frame", () => {
    expect(estimateGain(new Uint8ClampedArray(0), new Float32Array(0), 0)).toEqual({
      r: 1,
      g: 1,
      b: 1,
    });
  });
});

describe("describeGain", () => {
  it("formats all three channels", () => {
    expect(describeGain({ r: 1, g: 1.25, b: 0.8 })).toBe("1.00 1.25 0.80");
  });
});
