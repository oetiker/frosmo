import { describe, expect, it } from "vitest";
import { GLYPH_SIZE, normaliseGlyph, otsu } from "../src/vision/glyph.js";

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


describe("normaliseGlyph, dropping what runs off the crop", () => {
  const N = 48;
  /** Paper, with a small mark and a bar down one edge. */
  function crop(withBar: boolean): Uint8ClampedArray {
    const g = new Uint8ClampedArray(N * N).fill(240);
    for (let y = 18; y < 30; y++) for (let x = 20; x < 28; x++) g[y * N + x] = 20;
    if (withBar) for (let y = 0; y < N; y++) for (let x = 0; x < 3; x++) g[y * N + x] = 20;
    return g;
  }
  const inkOf = (b: Uint8Array) => b.reduce((n, v) => n + v, 0);

  it("is unchanged when nothing touches the edge", () => {
    const plain = normaliseGlyph(crop(false), N, N);
    const dropped = normaliseGlyph(crop(false), N, N, { dropEdgeTouching: true });
    expect([...dropped]).toEqual([...plain]);
  });

  it("throws away a neighbour's frame instead of scaling the glyph to fit beside it", () => {
    // The bounding box is taken over everything dark, so one stray bar down the
    // side widens it and the letter shrinks into a corner. Half the alphabet
    // came back like that before this existed.
    const alone = normaliseGlyph(crop(false), N, N, { dropEdgeTouching: true });
    const beside = normaliseGlyph(crop(true), N, N, { dropEdgeTouching: true });
    expect([...beside]).toEqual([...alone]);
    // Without the flag the mark is squeezed to a fraction of its proper size.
    expect(inkOf(normaliseGlyph(crop(true), N, N))).toBeLessThan(inkOf(alone) / 2);
  });

  it("keeps the dots of an umlaut, which touch nothing", () => {
    // The reason this is a flood fill and not a margin: the dots float clear of
    // the letter and clear of the edge, so the crop can stay generous.
    const g = crop(true);
    for (let y = 8; y < 12; y++) {
      for (let x = 20; x < 23; x++) g[y * N + x] = 20;
      for (let x = 25; x < 28; x++) g[y * N + x] = 20;
    }
    const dropped = normaliseGlyph(g, N, N, { dropEdgeTouching: true });
    // Ink in the top quarter, separated from the body below it: that is what a
    // diaeresis looks like once normalised, and the bar down the edge is gone.
    const band = (from: number, to: number) => {
      let n = 0;
      for (let y = from; y < to; y++) for (let x = 0; x < GLYPH_SIZE; x++) n += dropped[y * GLYPH_SIZE + x];
      return n;
    };
    expect(band(0, 6)).toBeGreaterThan(0);
    expect(band(7, 10)).toBe(0);
    expect(band(10, GLYPH_SIZE)).toBeGreaterThan(0);
    // And the letter is still centred, not pushed aside by a frame.
    let left = 0;
    for (let y = 0; y < GLYPH_SIZE; y++) for (let x = 0; x < 3; x++) left += dropped[y * GLYPH_SIZE + x];
    expect(left).toBe(0);
  });
});
