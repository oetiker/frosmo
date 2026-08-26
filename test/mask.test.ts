import { describe, expect, it } from "vitest";
import {
  blurToField,
  close,
  countMask,
  coverage,
  createMask,
  dilate,
  erode,
  iou,
  open,
  spill,
} from "../src/vision/mask.js";

function maskFrom(rows: string[]) {
  const h = rows.length;
  const w = rows[0].length;
  const m = createMask(w, h);
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      m.data[y * w + x] = c === "#" ? 1 : 0;
    });
  });
  return m;
}

function render(m: { w: number; h: number; data: Uint8Array }) {
  const out: string[] = [];
  for (let y = 0; y < m.h; y++) {
    let row = "";
    for (let x = 0; x < m.w; x++) row += m.data[y * m.w + x] ? "#" : ".";
    out.push(row);
  }
  return out;
}

describe("morphology", () => {
  it("erode removes a single-pixel speck entirely", () => {
    const m = maskFrom([".....", "..#..", ".....", ".....", "....."]);
    erode(m, new Uint8Array(25));
    expect(countMask(m)).toBe(0);
  });

  it("erode shrinks a block by one ring", () => {
    const m = maskFrom([".....", ".###.", ".###.", ".###.", "....."]);
    erode(m, new Uint8Array(25));
    expect(render(m)).toEqual([".....", ".....", "..#..", ".....", "....."]);
  });

  it("dilate grows a point into a 3x3 block", () => {
    const m = maskFrom([".....", ".....", "..#..", ".....", "....."]);
    dilate(m, new Uint8Array(25));
    expect(render(m)).toEqual([".....", ".###.", ".###.", ".###.", "....."]);
  });

  it("open keeps a real object while deleting noise", () => {
    const m = maskFrom([
      "#.......",
      "..####..",
      "..####..",
      "..####..",
      "..####..",
      ".......#",
      "........",
      "........",
    ]);
    open(m, new Uint8Array(64));
    expect(countMask(m)).toBeGreaterThan(8);
    expect(m.data[0]).toBe(0);
    expect(m.data[47]).toBe(0);
  });

  it("close bridges the gap in a broken pen stroke", () => {
    const m = maskFrom(["........", ".##.##..", ".##.##..", "........"]);
    close(m, new Uint8Array(32));
    expect(m.data[1 * 8 + 3]).toBe(1);
  });
});

describe("mask comparison", () => {
  const a = maskFrom(["####", "####", "....", "...."]);
  const b = maskFrom(["####", "....", "....", "...."]);

  it("iou is symmetric and bounded", () => {
    expect(iou(a, b)).toBeCloseTo(0.5, 6);
    expect(iou(b, a)).toBeCloseTo(0.5, 6);
    expect(iou(a, a)).toBe(1);
  });

  it("coverage measures how much of the target is filled", () => {
    expect(coverage(a, b)).toBeCloseTo(0.5, 6);
    expect(coverage(b, a)).toBe(1);
  });

  it("spill measures how much falls outside the target", () => {
    expect(spill(b, a)).toBeCloseTo(0.5, 6);
    expect(spill(a, b)).toBe(0);
  });

  it("is zero, not NaN, for empty masks", () => {
    const empty = createMask(4, 4);
    expect(iou(empty, empty)).toBe(0);
    expect(coverage(empty, a)).toBe(0);
    expect(spill(a, empty)).toBe(0);
  });
});

describe("blurToField", () => {
  it("produces a gradient that points out of the obstacle", () => {
    const m = createMask(32, 32);
    for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) m.data[y * 32 + x] = 1;
    const field = new Float32Array(32 * 32);
    blurToField(m, field, 2);

    const at = (x: number, y: number) => field[y * 32 + x];
    expect(at(16, 16)).toBeCloseTo(1, 2);
    expect(at(2, 2)).toBeCloseTo(0, 2);
    // Crossing the left edge, the field must fall as we move away.
    expect(at(10, 16)).toBeLessThan(at(13, 16));
    expect(at(13, 16)).toBeLessThan(at(16, 16));
  });
});
