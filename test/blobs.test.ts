import { describe, expect, it } from "vitest";
import { labelBlobs } from "../src/vision/blobs.js";
import { createMask } from "../src/vision/mask.js";

function fill(m: ReturnType<typeof createMask>, x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m.data[y * m.w + x] = 1;
}

describe("labelBlobs", () => {
  it("separates two pieces and measures each", () => {
    const m = createMask(40, 40);
    fill(m, 2, 2, 8, 8);
    fill(m, 25, 25, 6, 10);
    const { blobs } = labelBlobs(m, { minArea: 4 });

    expect(blobs).toHaveLength(2);
    expect(blobs[0].area).toBe(64);
    expect(blobs[0].cx).toBeCloseTo(5.5, 6);
    expect(blobs[0].cy).toBeCloseTo(5.5, 6);
    expect(blobs[1].area).toBe(60);
    expect(blobs[1].minX).toBe(25);
    expect(blobs[1].maxY).toBe(34);
  });

  it("does not merge tiles that only touch at a corner", () => {
    const m = createMask(20, 20);
    fill(m, 2, 2, 4, 4);
    fill(m, 6, 6, 4, 4);
    expect(labelBlobs(m, { minArea: 4 }).blobs).toHaveLength(2);
  });

  it("drops noise below minArea and arms above maxAreaFraction", () => {
    const m = createMask(20, 20);
    m.data[0] = 1;
    fill(m, 5, 5, 4, 4);
    fill(m, 0, 10, 20, 9);
    const { blobs } = labelBlobs(m, { minArea: 8, maxAreaFraction: 0.3 });
    expect(blobs).toHaveLength(1);
    expect(blobs[0].area).toBe(16);
  });

  it("averages colour over the blob", () => {
    const m = createMask(10, 10);
    fill(m, 1, 1, 2, 2);
    const rgba = new Uint8ClampedArray(400);
    for (let i = 0; i < 100; i++) {
      rgba[i * 4] = 200;
      rgba[i * 4 + 1] = 20;
      rgba[i * 4 + 2] = 60;
    }
    const { blobs } = labelBlobs(m, { minArea: 1, rgba });
    expect(blobs[0].r).toBeCloseTo(200, 6);
    expect(blobs[0].g).toBeCloseTo(20, 6);
  });

  it("reports elongation: a stroke is thin, a token is not", () => {
    const m = createMask(40, 40);
    fill(m, 2, 20, 30, 2);
    const stroke = labelBlobs(m, { minArea: 4 }).blobs[0];
    expect(stroke.elongation).toBeGreaterThan(4);
    expect(Math.abs(stroke.angle)).toBeLessThan(0.1);

    const m2 = createMask(40, 40);
    fill(m2, 10, 10, 8, 8);
    expect(labelBlobs(m2, { minArea: 4 }).blobs[0].elongation).toBeLessThan(1.2);
  });

  it("survives a mask that is one large connected region", () => {
    const m = createMask(64, 64);
    m.data.fill(1);
    const { blobs } = labelBlobs(m, { minArea: 1, maxAreaFraction: 1 });
    expect(blobs).toHaveLength(1);
    expect(blobs[0].area).toBe(64 * 64);
  });

  it("sorts blobs largest first and honours the limit", () => {
    const m = createMask(40, 40);
    fill(m, 1, 1, 3, 3);
    fill(m, 10, 10, 9, 9);
    fill(m, 25, 2, 5, 5);
    const { blobs } = labelBlobs(m, { minArea: 4, limit: 2 });
    expect(blobs).toHaveLength(2);
    expect(blobs[0].area).toBe(81);
    expect(blobs[1].area).toBe(25);
  });
});
