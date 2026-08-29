import { describe, expect, it } from "vitest";
import {
  agreement,
  GLYPH_SIZE,
  matchGlyph,
  normaliseGlyph,
  otsu,
  rotateQuarter,
  type GlyphAtlas,
} from "../src/vision/glyph.js";

/** Draw a filled rectangle of dark ink on a light field. */
function inkRect(w: number, h: number, x0: number, y0: number, rw: number, rh: number) {
  const g = new Uint8ClampedArray(w * h).fill(235);
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) g[y * w + x] = 25;
  return g;
}

function glyph(rows: string[]): Uint8Array {
  const out = new Uint8Array(GLYPH_SIZE * GLYPH_SIZE);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === "#") out[y * GLYPH_SIZE + x] = 1;
    }),
  );
  return out;
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

describe("rotateQuarter", () => {
  it("returns to the original after four turns", () => {
    const g = glyph(["####", "#...", "#...", "#..."]);
    let r = g;
    for (let i = 0; i < 4; i++) r = rotateQuarter(r, 1);
    expect([...r]).toEqual([...g]);
  });

  it("moves a corner mark around the square", () => {
    const g = new Uint8Array(GLYPH_SIZE * GLYPH_SIZE);
    g[0] = 1; // top-left
    expect(rotateQuarter(g, 1)[GLYPH_SIZE - 1]).toBe(1); // top-right
    expect(rotateQuarter(g, 2)[GLYPH_SIZE * GLYPH_SIZE - 1]).toBe(1); // bottom-right
  });
});

describe("matchGlyph", () => {
  const L = glyph(["#...", "#...", "#...", "####"]);
  const T = glyph(["####", ".#..", ".#..", ".#.."]);
  const atlas: GlyphAtlas = { chars: ["L", "T"], templates: [L, T], font: "test" };

  it("picks the right character", () => {
    expect(matchGlyph(L, atlas)?.char).toBe("L");
    expect(matchGlyph(T, atlas)?.char).toBe("T");
  });

  it("reads a tile lying on its side", () => {
    const m = matchGlyph(rotateQuarter(L, 1), atlas);
    expect(m?.char).toBe("L");
    expect(m?.rotation).toBeGreaterThan(0);
  });

  it("reports a healthy margin for an unambiguous match", () => {
    expect(matchGlyph(L, atlas)!.margin).toBeGreaterThan(0.2);
  });

  it("reports a thin margin when the sample suits both templates", () => {
    // A shape half-way between L and T scores similarly against each.
    const mixed = glyph(["####", "##..", "#...", "###."]);
    expect(matchGlyph(mixed, atlas)!.margin).toBeLessThan(0.2);
  });

  it("returns null for an empty atlas or blank sample", () => {
    expect(matchGlyph(L, { chars: [], templates: [], font: "" })).toBeNull();
    expect(matchGlyph(new Uint8Array(GLYPH_SIZE * GLYPH_SIZE), atlas)).toBeNull();
  });
});

describe("the confusions seen on a real sheet", () => {
  // D and 0 differ by a straight left edge; A and 4 by an apex. At this
  // resolution those are a few pixels, which is why on a real sheet a D read as
  // 0 and an A as 4 — while F, which no digit resembles, read correctly.
  const D = glyph(["####..", "#...#.", "#...#.", "#...#.", "#...#.", "####.."]);
  const ZERO = glyph([".###..", "#...#.", "#...#.", "#...#.", "#...#.", ".###.."]);
  const F = glyph(["#####.", "#.....", "####..", "#.....", "#.....", "#....."]);

  const withDigits: GlyphAtlas = { chars: ["D", "F", "0"], templates: [D, F, ZERO], font: "test" };
  const lettersOnly: GlyphAtlas = { chars: ["D", "F"], templates: [D, F], font: "test" };

  it("gives a letter no room when its digit lookalike is in the running", () => {
    const match = matchGlyph(D, withDigits)!;
    expect(match.char).toBe("D");
    // Correct, but only just — and a real capture is not this clean.
    expect(match.margin).toBeLessThan(0.35);
  });

  it("is decisive once the game names the alphabet it uses", () => {
    // The same fix as restricting the colour palette: remove competitors that
    // were never real for this game.
    const match = matchGlyph(D, lettersOnly)!;
    expect(match.char).toBe("D");
    expect(match.margin).toBeGreaterThan(0.5);
  });

  it("reads a distinctive letter either way", () => {
    // F was right on the real sheet, and should stay right.
    expect(matchGlyph(F, withDigits)?.char).toBe("F");
    expect(matchGlyph(F, lettersOnly)?.char).toBe("F");
  });
});

describe("upright preference", () => {
  const M = glyph(["#...#", "##.##", "#.#.#", "#...#", "#...#"]);
  const W = rotateQuarter(M, 2);
  const atlas: GlyphAtlas = { chars: ["M", "W"], templates: [M, W], font: "test" };

  it("penalises a reading that needs the tile turned", () => {
    // M and W are the same shape turned over, as are N and Z, and 6 and 9.
    // Letters on a sheet are upright, so upright must win a close contest.
    const upright = matchGlyph(M, atlas, { rotationPenalty: 0.08 })!;
    expect(upright.char).toBe("M");
    expect(upright.rotation).toBe(0);
  });

  it("still reads a tile that really is sideways", () => {
    // The penalty is a tie-breaker, not a ban: a genuinely rotated glyph still
    // wins, because nothing upright comes close to it.
    const sideways = matchGlyph(rotateQuarter(M, 1), atlas, { rotationPenalty: 0.08 })!;
    expect(sideways.rotation).not.toBe(0);
  });

  it("reports a lower score for a rotated reading, by the penalty", () => {
    const plain = matchGlyph(rotateQuarter(M, 1), atlas, { rotationPenalty: 0 })!;
    const penalised = matchGlyph(rotateQuarter(M, 1), atlas, { rotationPenalty: 0.08 })!;
    expect(plain.score - penalised.score).toBeCloseTo(0.08, 6);
  });
});
