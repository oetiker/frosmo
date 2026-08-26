import { describe, expect, it } from "vitest";
import { simplify, traceContours } from "../src/vision/contour.js";
import { createMask } from "../src/vision/mask.js";

function box(m: ReturnType<typeof createMask>, x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m.data[y * m.w + x] = 1;
}

describe("traceContours", () => {
  it("returns nothing for an empty mask", () => {
    expect(traceContours(createMask(20, 20))).toEqual([]);
  });

  it("outlines a rectangle within its own bounds", () => {
    const m = createMask(40, 40);
    box(m, 10, 8, 16, 20);
    const contours = traceContours(m, 4);
    expect(contours.length).toBeGreaterThanOrEqual(1);

    const pts = contours[0];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    expect(minX).toBeGreaterThanOrEqual(9);
    expect(maxX).toBeLessThanOrEqual(27);
    expect(minY).toBeGreaterThanOrEqual(7);
    expect(maxY).toBeLessThanOrEqual(29);
  });

  it("finds one outline per separate piece", () => {
    const m = createMask(60, 30);
    box(m, 4, 4, 12, 12);
    box(m, 40, 6, 14, 14);
    expect(traceContours(m, 4).length).toBe(2);
  });

  it("terminates on a fully covered board", () => {
    const m = createMask(32, 32);
    m.data.fill(1);
    expect(() => traceContours(m, 4)).not.toThrow();
  });
});

describe("simplify", () => {
  it("collapses a straight stair-step run to its endpoints", () => {
    const line: number[] = [];
    for (let i = 0; i <= 20; i++) line.push(i, 0);
    expect(simplify(line, 1)).toEqual([0, 0, 20, 0]);
  });

  it("keeps a genuine corner", () => {
    const l: number[] = [];
    for (let i = 0; i <= 10; i++) l.push(i, 0);
    for (let i = 1; i <= 10; i++) l.push(10, i);
    const s = simplify(l, 1);
    expect(s).toEqual([0, 0, 10, 0, 10, 10]);
  });

  it("leaves degenerate input untouched", () => {
    expect(simplify([1, 2], 1)).toEqual([1, 2]);
  });

  it("removes more points as tolerance grows", () => {
    const wobbly: number[] = [];
    for (let i = 0; i <= 40; i++) wobbly.push(i, i % 2);
    expect(simplify(wobbly, 2).length).toBeLessThan(simplify(wobbly, 0.4).length);
  });
});
