/**
 * Reading the card turns shipped constants into measurements of one rig.
 *
 * Each case puts a known distortion into the picture and asks whether the
 * profile finds it: a camera with a colour cast, a lens out of focus, a lamp
 * too bright to measure anything by.
 */
import { describe, expect, it } from "vitest";
import { measureCard } from "../src/vision/card-profile.js";
import { CARD_ASPECT, CARD_WIDTH_MM, SWATCHES } from "../src/vision/card.js";
import { drawCardFlat } from "./helpers/card.js";

const W = 512;
const H = Math.round(512 / CARD_ASPECT);

describe("measureCard", () => {
  it("finds nothing to correct when the camera is neutral", () => {
    const p = measureCard(drawCardFlat(W, H), W, H);
    expect(p.gain.r).toBeCloseTo(1, 1);
    expect(p.gain.g).toBeCloseTo(1, 1);
    expect(p.gain.b).toBeCloseTo(1, 1);
    expect(p.warnings).toEqual([]);
  });

  it("undoes a colour cast", () => {
    // A warm lamp, or an iPad deciding the room is warmer than it is: blue is
    // held back, and the gain has to put it back or every token reads orange.
    const p = measureCard(drawCardFlat(W, H, { tint: [1, 0.92, 0.78] }), W, H);
    expect(p.gain.b / p.gain.r).toBeGreaterThan(1.2);
    // Applying it should bring the channels back level.
    const white = [248 * 1, 248 * 0.92, 248 * 0.78];
    const fixed = [white[0] * p.gain.r, white[1] * p.gain.g, white[2] * p.gain.b];
    expect(Math.max(...fixed) - Math.min(...fixed)).toBeLessThan(6);
  });

  it("measures how far out of focus the lens is", () => {
    const sharp = measureCard(drawCardFlat(W, H), W, H);
    const soft = measureCard(drawCardFlat(W, H, { blur: 3 }), W, H);
    expect(soft.blur).toBeGreaterThan(sharp.blur + 1);
  });

  it("asks for less contrast from a lens that cannot deliver it", () => {
    // The threshold the ink detector should use is a property of the rig, not a
    // number to be shipped. A softer lens loses the fine rules, so less is
    // asked of every stroke.
    const sharp = measureCard(drawCardFlat(W, H), W, H);
    const soft = measureCard(drawCardFlat(W, H, { blur: 4 }), W, H);
    expect(sharp.ink.contrast).toBeGreaterThan(0.05);
    expect(soft.ink.contrast).toBeLessThanOrEqual(sharp.ink.contrast);
  });

  it("reads the token inks through this camera, not from a table of hex codes", () => {
    const p = measureCard(drawCardFlat(W, H, { tint: [1, 0.94, 0.82] }), W, H);
    expect(p.palette.map((s) => s.name)).toEqual(SWATCHES.map((s) => s.name));
    const by = Object.fromEntries(p.palette.map((s) => [s.name, s.rgb]));
    // Red reddest, blue bluest, green greenest — after the cast has been undone.
    expect(by.red[0]).toBeGreaterThan(by.red[2]);
    expect(by.blue[2]).toBeGreaterThan(by.blue[0]);
    expect(by.green[1]).toBeGreaterThan(by.green[0]);
  });

  it("knows the size of everything it printed", () => {
    const p = measureCard(drawCardFlat(W, H), W, H);
    // The card's own printed width, across the buffer it was rectified into.
    expect(p.mmPerPixel).toBeCloseTo(CARD_WIDTH_MM / W, 5);
  });

  it("says so when the lamp is too bright to measure by", () => {
    const p = measureCard(drawCardFlat(W, H, { tint: [1.2, 1.2, 1.2] }), W, H);
    expect(p.warnings.join(" ")).toContain("clipped");
  });
});
