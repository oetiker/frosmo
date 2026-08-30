import { describe, expect, it } from "vitest";
import { normaliseGlyph, otsu } from "../src/vision/glyph.js";

/** Draw a filled rectangle of dark ink on a light field. */
function inkRect(w: number, h: number, x0: number, y0: number, rw: number, rh: number) {
  const g = new Uint8ClampedArray(w * h).fill(235);
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) g[y * w + x] = 25;
  return g;
}

/** Overlap between two binary bitmaps, for comparing normalised glyphs. */
function agreement(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] & b[i]) inter++;
    if (a[i] | b[i]) union++;
  }
  return union === 0 ? 0 : inter / union;
}

describe("otsu", () => {
  it("finds a threshold between two clear populations", () => {
    const g = new Uint8ClampedArray(1000);
    g.fill(30, 0, 400);
    g.fill(220, 400);
    // The dark class is `value <= t`, so splitting exactly on the dark
    // population's own value is correct, not off by one.
    const t = otsu(g);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });
});

describe("normaliseGlyph", () => {
  it("crops to the ink and centres it", () => {
    // Same mark, two positions in the tile: normalisation must erase the offset.
    const a = normaliseGlyph(inkRect(48, 48, 4, 4, 12, 20), 48, 48);
    const b = normaliseGlyph(inkRect(48, 48, 30, 24, 12, 20), 48, 48);
    expect(agreement(a, b)).toBeGreaterThan(0.95);
  });

  it("is scale invariant: a tile nearer the mirror still matches", () => {
    const small = normaliseGlyph(inkRect(48, 48, 10, 10, 8, 14), 48, 48);
    const large = normaliseGlyph(inkRect(96, 96, 20, 20, 16, 28), 96, 96);
    expect(agreement(small, large)).toBeGreaterThan(0.9);
  });

  it("preserves aspect ratio, so a bar does not become a square", () => {
    const bar = normaliseGlyph(inkRect(48, 48, 20, 8, 4, 32), 48, 48);
    const square = normaliseGlyph(inkRect(48, 48, 12, 12, 24, 24), 48, 48);
    expect(agreement(bar, square)).toBeLessThan(0.5);
  });

  it("returns an empty bitmap for a blank tile", () => {
    const blank = new Uint8ClampedArray(48 * 48).fill(200);
    expect(normaliseGlyph(blank, 48, 48).some((v) => v)).toBe(false);
  });
});

