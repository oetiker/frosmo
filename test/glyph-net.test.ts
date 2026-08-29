import { describe, expect, it } from "vitest";
import { MODEL_ACCURACY, MODEL_CHARS, readGlyph } from "../src/vision/glyph-net.js";
import { GLYPH_SIZE } from "../src/vision/glyph.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A bitmap of the right shape, with some ink in it. */
function sample(seed = 1): Uint8Array {
  const out = new Uint8Array(GLYPH_SIZE * GLYPH_SIZE);
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 20) % 3 === 0 ? 1 : 0;
  }
  return out;
}

describe("the committed model", () => {
  it("covers the whole character set", () => {
    expect(MODEL_CHARS).toHaveLength(36);
    for (const ch of LETTERS + "0123456789") expect(MODEL_CHARS).toContain(ch);
  });

  it("is not a broken or undertrained artefact", () => {
    // A guard on the file itself. The weights are generated and committed, so
    // nothing else would notice a training run that went wrong before it was
    // deployed to a tablet on a kitchen table.
    expect(MODEL_ACCURACY.letters).toBeGreaterThan(0.9);
    expect(MODEL_ACCURACY.digits).toBeGreaterThan(0.85);
  });
});

describe("readGlyph", () => {
  it("returns a character, a confidence and a margin", () => {
    const result = readGlyph(sample())!;
    expect(MODEL_CHARS).toContain(result.char);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.margin).toBeGreaterThanOrEqual(0);
    expect(result.margin).toBeLessThanOrEqual(1);
  });

  it("never answers outside the alphabet it was given", () => {
    // The restriction masks the scores rather than filtering afterwards, so a
    // letter is never asked to out-score a digit it will never be shown beside.
    for (let seed = 1; seed < 40; seed++) {
      const result = readGlyph(sample(seed), LETTERS)!;
      expect(LETTERS).toContain(result.char);
    }
  });

  it("is more certain within a smaller alphabet", () => {
    // Same input, fewer rivals: the winner keeps its share and the losers'
    // probability is redistributed, so confidence can only rise.
    let rose = 0;
    for (let seed = 1; seed < 20; seed++) {
      const all = readGlyph(sample(seed))!;
      const letters = readGlyph(sample(seed), LETTERS)!;
      if (letters.confidence >= all.confidence - 1e-9) rose++;
    }
    expect(rose).toBe(19);
  });

  it("rejects a bitmap of the wrong size", () => {
    expect(readGlyph(new Uint8Array(10))).toBeNull();
  });

  it("is deterministic", () => {
    const a = readGlyph(sample(7))!;
    const b = readGlyph(sample(7))!;
    expect(a).toEqual(b);
  });

  it("handles a blank bitmap without producing a confident answer", () => {
    const blank = readGlyph(new Uint8Array(GLYPH_SIZE * GLYPH_SIZE))!;
    expect(blank.confidence).toBeLessThan(0.9);
  });
});
