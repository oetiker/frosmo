import { describe, expect, it } from "vitest";
import {
  foldAngle,
  glyphCandidate,
  glyphLimits,
  glyphMinArea,
  GLYPH_LIMITS,
} from "../src/vision/tiles.js";

describe("glyphCandidate, against shapes measured from a real capture", () => {
  const blob = (bw: number, bh: number, fill: number) => {
    const area = Math.round(bw * bh * fill);
    return { id: 1, area, cx: 0, cy: 0, minX: 0, minY: 0, maxX: bw - 1, maxY: bh - 1, r: 0, g: 0, b: 0, angle: 0, elongation: 1 };
  };

  it("accepts the letters as they actually appeared", () => {
    // Straight from the capture: area, bounding box and fill of real letters.
    for (const [bw, bh, fill] of [
      [9, 11, 0.62],
      [8, 16, 0.51],
      [16, 18, 0.48],
      [13, 18, 0.55],
      [10, 7, 0.64],
      [5, 17, 0.29],
    ] as const) {
      expect(glyphCandidate(blob(bw, bh, fill))).toBe("ok");
    }
  });

  it("rejects a tile's printed border", () => {
    // A big hollow ring. This is the shape that has to reject itself, because
    // it surrounds the very glyph we want and would otherwise be read instead.
    // Rejected for being a long hollow box. Which rule catches it first is an
    // implementation detail; that it never reaches the recogniser is not.
    expect(glyphCandidate(blob(87, 40, 0.12))).not.toBe("ok");
    // This one isolates the fill test: square enough, small enough, but hollow.
    expect(glyphCandidate(blob(34, 27, 0.16))).toBe("hollow");
  });

  it("rejects a line of caption text", () => {
    expect(glyphCandidate(blob(36, 10, 0.47))).toBe("wrong-shape");
  });

  it("rejects sensor speckle", () => {
    expect(glyphCandidate(blob(3, 3, 0.9))).toBe("too-small");
  });

  it("scales its minimum area with the board", () => {
    // The pipeline's general blob minimum is tuned for tokens and would have
    // discarded most of these letters before they were ever looked at.
    expect(glyphMinArea(320, 240)).toBeLessThan(Math.round(320 * 240 * 0.0008));
    expect(glyphMinArea(320, 240)).toBeGreaterThanOrEqual(8);
    expect(glyphMinArea(192, 144)).toBeLessThan(glyphMinArea(320, 240));
  });

  it("honours overridden limits", () => {
    expect(glyphCandidate(blob(9, 11, 0.62), { ...GLYPH_LIMITS, minFill: 0.9 })).toBe("hollow");
  });

  it("scales with the board rather than assuming one size", () => {
    // The same sheet on a smaller board has proportionally smaller letters.
    expect(glyphLimits(192, 144).maxArea).toBeLessThan(glyphLimits(320, 240).maxArea);
    expect(glyphLimits(640, 480).minHeight).toBeGreaterThan(glyphLimits(320, 240).minHeight);
  });
});

describe("foldAngle", () => {
  it("folds a square's ambiguous axis into a quarter turn", () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(foldAngle(deg(0))).toBeCloseTo(0, 6);
    expect(foldAngle(deg(10))).toBeCloseTo(deg(10), 6);
    expect(foldAngle(deg(80))).toBeCloseTo(deg(-10), 6);
  });

  it("always lands inside plus or minus 45 degrees", () => {
    for (let d = -180; d <= 180; d += 7) {
      expect(Math.abs(foldAngle((d * Math.PI) / 180))).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
    }
  });
});
