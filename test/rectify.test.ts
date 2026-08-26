import { describe, expect, it } from "vitest";
import { solveHomography, unitQuad, type Quad } from "../src/vision/homography.js";
import { buildSampleTable, createRectifiedFrame, rectify } from "../src/vision/rectify.js";

/** Fill a fake camera frame with a horizontal red-to-blue ramp. */
function ramp(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = Math.round((x / (w - 1)) * 255);
      data[o + 1] = 0;
      data[o + 2] = Math.round((y / (h - 1)) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

describe("buildSampleTable", () => {
  it("samples the region the calibration quad covers", () => {
    // Board maps onto the right half of a 100x100 frame.
    const dst: Quad = [
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 50, y: 100 },
    ];
    const table = buildSampleTable(solveHomography(unitQuad(), dst), { w: 10, h: 10 }, 100, 100);
    for (const offset of table) {
      expect(offset).toBeGreaterThanOrEqual(0);
      const px = (offset / 4) % 100;
      expect(px).toBeGreaterThanOrEqual(50);
    }
  });

  it("marks samples that fall outside the frame", () => {
    const dst: Quad = [
      { x: -40, y: -40 },
      { x: 40, y: -40 },
      { x: 40, y: 40 },
      { x: -40, y: 40 },
    ];
    const table = buildSampleTable(solveHomography(unitQuad(), dst), { w: 8, h: 8 }, 100, 100);
    expect([...table].some((o) => o < 0)).toBe(true);
  });
});

describe("rectify", () => {
  it("undoes perspective: a trapezoid in the image becomes a rectangle in board space", () => {
    const w = 120;
    const h = 120;
    const src = ramp(w, h);
    // A trapezoid whose top edge is half the width of its bottom edge.
    const dst: Quad = [
      { x: 30, y: 0 },
      { x: 90, y: 0 },
      { x: 120, y: 119 },
      { x: 0, y: 119 },
    ];
    const table = buildSampleTable(solveHomography(unitQuad(), dst), { w: 16, h: 16 }, w, h);
    const frame = createRectifiedFrame({ w: 16, h: 16 });
    rectify(src, table, frame);

    // The red channel is the image x-ramp. After rectification the left column
    // of the board must be red-low and the right column red-high on every row,
    // even though those columns sit at very different image x on the near and
    // far edges.
    for (let y = 0; y < 16; y++) {
      const left = frame.rgba[(y * 16) * 4];
      const right = frame.rgba[(y * 16 + 15) * 4];
      expect(right).toBeGreaterThan(left);
    }

    // And a board row must be a constant image y, so the blue channel is
    // constant across each rectified row.
    for (let y = 0; y < 16; y++) {
      const first = frame.rgba[(y * 16) * 4 + 2];
      for (let x = 1; x < 16; x++) {
        expect(Math.abs(frame.rgba[(y * 16 + x) * 4 + 2] - first)).toBeLessThanOrEqual(3);
      }
    }
  });

  it("computes luma and writes opaque pixels", () => {
    const src = new Uint8ClampedArray([255, 255, 255, 255]);
    const table = Int32Array.of(0, -1);
    const frame = createRectifiedFrame({ w: 2, h: 1 });
    rectify(src, table, frame);
    expect(frame.gray[0]).toBeGreaterThan(250);
    expect(frame.gray[1]).toBe(0);
    expect(frame.rgba[3]).toBe(255);
    expect(frame.rgba[7]).toBe(255);
  });
});
