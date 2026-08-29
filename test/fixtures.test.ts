/**
 * Measurements from a real rig, kept as a fixture.
 *
 * These are not values anyone invented: they are what an iPad's back camera
 * reported for the app's own printed token sheet, lying on a desk, captured
 * through the diagnostic export on 2026-08-29. A synthetic scene drawn by the
 * same person who wrote the detector agrees with the detector by construction;
 * this does not.
 */

import { describe, expect, it } from "vitest";
import { classifyColor, type TokenColor } from "../src/vision/color.js";

/** Mean RGB of each detected token, grouped by the ink that printed it. */
const MEASURED: Record<string, Array<[number, number, number]>> = {
  red: [
    [171, 85, 74],
    [174, 86, 76],
    [174, 85, 73],
    [175, 83, 72],
    [174, 82, 70],
  ],
  orange: [
    [223, 150, 82],
    [223, 143, 78],
    [222, 146, 78],
    [218, 146, 81],
    [216, 143, 77],
  ],
  green: [
    [70, 119, 91],
    [67, 117, 89],
    [69, 114, 87],
    [67, 115, 89],
    [65, 115, 87],
    [66, 116, 88],
    [68, 115, 87],
    [66, 115, 87],
    [67, 115, 88],
  ],
  blue: [
    [66, 105, 137],
    [64, 102, 136],
    [63, 103, 138],
    [57, 101, 138],
    [61, 102, 138],
    [60, 101, 136],
    [58, 101, 139],
    [60, 101, 136],
  ],
};

/** What Colour Rush plays with, and the confidence it insists on. */
const PALETTE: TokenColor[] = ["red", "orange", "green", "blue"];
const MIN_CONFIDENCE = 0.12;

const all = Object.entries(MEASURED).flatMap(([ink, samples]) =>
  samples.map((rgb) => ({ ink, rgb })),
);

describe("the printed token sheet, as a real camera sees it", () => {
  it("identifies every token by the ink that printed it", () => {
    for (const { ink, rgb } of all) {
      expect(classifyColor(rgb[0], rgb[1], rgb[2], { palette: PALETTE }).color).toBe(ink);
    }
  });

  it("is confident enough about all of them for a game to act", () => {
    const usable = all.filter(
      ({ rgb }) =>
        classifyColor(rgb[0], rgb[1], rgb[2], { palette: PALETTE }).confidence >= MIN_CONFIDENCE,
    );
    expect(usable).toHaveLength(all.length);
  });

  it("shows what the unrestricted classifier did to green and blue", () => {
    // The bug this fixture was collected for. Green photographs at about 145
    // degrees and blue at 207 — both flanking the cyan centre at 180, which is
    // not an ink on the sheet and never was. Cyan took enough of the margin to
    // push green below the confidence a game will act on.
    const greens = MEASURED.green.map((rgb) => classifyColor(rgb[0], rgb[1], rgb[2]));
    expect(greens.every((m) => m.color === "green")).toBe(true);
    expect(Math.min(...greens.map((m) => m.confidence))).toBeLessThan(MIN_CONFIDENCE);

    const restricted = MEASURED.green.map((rgb) =>
      classifyColor(rgb[0], rgb[1], rgb[2], { palette: PALETTE }),
    );
    expect(Math.min(...restricted.map((m) => m.confidence))).toBeGreaterThan(0.4);
  });

  it("shows the amber ink is orange, not yellow", () => {
    // Printed #f2b705, which is hue 45 on screen. Through a camera, under room
    // light, it lands at 28 — orange. The game used to ask for "yellow", so
    // every one of these was classified correctly and then thrown away.
    for (const rgb of MEASURED.orange) {
      expect(classifyColor(rgb[0], rgb[1], rgb[2]).color).toBe("orange");
    }
  });
});
