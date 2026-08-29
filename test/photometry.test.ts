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

  it("clamps rather than exploding on a pathological frame", () => {
    const black = frame(() => [1, 1, 1]);
    const gain = estimateGain(black, reference(() => [250, 250, 250]), PIXELS, { floor: 0 });
    expect(gain.r).toBeLessThanOrEqual(2.5);
    expect(gain.r).toBeGreaterThan(1);
  });

  it("leaves near-black channels alone", () => {
    // A ratio between two nearly black values is amplified noise, not a gain.
    const gain = estimateGain(frame(() => [2, 180, 180]), reference(() => [3, 174, 174]), PIXELS);
    expect(gain.r).toBe(1);
    expect(gain.g).not.toBe(1);
  });

  it("honours the clamp options", () => {
    const darker = frame(() => [90, 90, 90]);
    const gain = estimateGain(darker, reference(() => [180, 180, 180]), PIXELS, { max: 1.5 });
    expect(gain.r).toBe(1.5);
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
