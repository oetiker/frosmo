import { describe, expect, it } from "vitest";
import { letterbox, normaliseInRect } from "../src/util/layout.js";
import { computeLayout } from "../src/games/types.js";

describe("letterbox", () => {
  it("fills exactly when the aspects match", () => {
    expect(letterbox(400, 300, 4 / 3)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("bars the sides when the container is wider than the source", () => {
    const r = letterbox(800, 300, 4 / 3);
    expect(r).toEqual({ x: 200, y: 0, w: 400, h: 300 });
  });

  it("bars the top and bottom when the container is taller", () => {
    const r = letterbox(400, 600, 4 / 3);
    expect(r).toEqual({ x: 0, y: 150, w: 400, h: 300 });
  });

  it("stays inside the container and centred, for any aspect", () => {
    for (const aspect of [0.5, 1, 1.33, 1.78, 3]) {
      for (const [cw, ch] of [
        [1180, 723],
        [820, 1180],
        [500, 500],
      ]) {
        const r = letterbox(cw, ch, aspect);
        expect(r.w).toBeLessThanOrEqual(cw + 1e-9);
        expect(r.h).toBeLessThanOrEqual(ch + 1e-9);
        expect(r.w / r.h).toBeCloseTo(aspect, 6);
        expect(r.x * 2 + r.w).toBeCloseTo(cw, 6);
        expect(r.y * 2 + r.h).toBeCloseTo(ch, 6);
      }
    }
  });

  it("degrades to the container for nonsense input", () => {
    expect(letterbox(100, 50, 0)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(letterbox(0, 0, 1.5)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("normaliseInRect", () => {
  const rect = { x: 100, y: 50, w: 400, h: 300 };

  it("maps the rect's own corners to 0 and 1", () => {
    expect(normaliseInRect(rect, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(normaliseInRect(rect, 500, 350)).toEqual({ x: 1, y: 1 });
  });

  it("ignores the letterbox bars around it", () => {
    // A point a quarter of the way across a 600-wide container is NOT a
    // quarter of the way across a 400-wide video centred in it. This is the
    // bug the whole module exists to prevent.
    const container = letterbox(600, 300, 4 / 3);
    const stageQuarter = normaliseInRect(container, 150, 75);
    expect(stageQuarter.x).toBeCloseTo(0.125, 6);
    expect(stageQuarter.y).toBeCloseTo(0.25, 6);
  });

  it("clamps a drag outside the frame", () => {
    expect(normaliseInRect(rect, -80, 900)).toEqual({ x: 0, y: 1 });
  });
});

describe("computeLayout", () => {
  it("shares the letterbox maths", () => {
    const layout = computeLayout(800, 300, { w: 1, h: 0.75 });
    expect(layout).toMatchObject({ x: 200, y: 0, w: 400, h: 300, scale: 400 });
  });

  it("scales board units to canvas pixels", () => {
    const layout = computeLayout(1000, 1000, { w: 1, h: 0.5 });
    expect(layout.scale).toBe(1000);
    expect(layout.y).toBe(250);
  });
});
