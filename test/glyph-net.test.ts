import { describe, expect, it } from "vitest";
import { MODEL_ACCURACY, MODEL_CHARS, readGlyph } from "../src/vision/glyph-net.js";
import { GLYPH_SIZE } from "../src/vision/glyph.js";
import fixture from "./fixtures/rig-candidates.json";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function bitmap(hex: string): Uint8Array {
  const out = new Uint8Array(GLYPH_SIZE * GLYPH_SIZE);
  for (let i = 0; i < hex.length; i++) {
    const v = parseInt(hex[i], 16);
    out[i * 4] = (v >> 3) & 1;
    out[i * 4 + 1] = (v >> 2) & 1;
    out[i * 4 + 2] = (v >> 1) & 1;
    out[i * 4 + 3] = v & 1;
  }
  return out;
}

/** Real characters, photographed on the rig. */
const glyphs = fixture.candidates.filter((c) => c.label !== "").map((c) => bitmap(c.bits));

/** A bitmap of the right shape holding nothing but noise. */
function noise(seed = 1): Uint8Array {
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
    //
    // These are lower than the 36-class model this replaced (93.6% on letters)
    // because they are measured against a model that is allowed to refuse, and
    // refusing a letter counts here as getting it wrong. What that bought is
    // the third number: on a real sheet, junk outnumbers letters two to one,
    // and a model that cannot refuse names every piece of it.
    expect(MODEL_ACCURACY.letters).toBeGreaterThan(0.78);
    expect(MODEL_ACCURACY.digits).toBeGreaterThan(0.78);
    expect(MODEL_ACCURACY.junkRefused).toBeGreaterThan(0.85);
    expect(MODEL_ACCURACY.lettersRefused).toBeLessThan(0.1);
  });
});

describe("readGlyph", () => {
  it("returns a character, a confidence and a margin", () => {
    const result = readGlyph(glyphs[0])!;
    expect(MODEL_CHARS).toContain(result.char);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.margin).toBeGreaterThanOrEqual(0);
    expect(result.margin).toBeLessThanOrEqual(1);
  });

  it("never answers outside the alphabet it was given", () => {
    // The restriction masks the scores rather than filtering afterwards, so a
    // letter is never asked to out-score a digit it will never be shown beside.
    for (const g of glyphs) {
      const result = readGlyph(g, LETTERS);
      if (result) expect(LETTERS).toContain(result.char);
    }
  });

  it("can still refuse inside a restricted alphabet", () => {
    // Narrowing the answer to letters says which letters might appear, not that
    // what the camera found is one of them. The reject class is never masked.
    expect(readGlyph(noise(3), LETTERS)).toBeNull();
  });

  it("is more certain within a smaller alphabet", () => {
    // Same input, fewer rivals: the winner keeps its share and the losers'
    // probability is redistributed, so confidence can only rise.
    let compared = 0;
    let rose = 0;
    for (const g of glyphs) {
      const all = readGlyph(g);
      const letters = readGlyph(g, LETTERS);
      if (!all || !letters || all.char !== letters.char) continue;
      compared++;
      if (letters.confidence >= all.confidence - 1e-9) rose++;
    }
    expect(compared).toBeGreaterThan(2);
    expect(rose).toBe(compared);
  });

  it("rejects a bitmap of the wrong size", () => {
    expect(readGlyph(new Uint8Array(10))).toBeNull();
  });

  it("is deterministic", () => {
    expect(readGlyph(glyphs[1])).toEqual(readGlyph(glyphs[1]));
  });

  it("refuses noise instead of naming it", () => {
    // This is the whole point of the extra class. A 36-way net handed static
    // answers with a letter, and means it.
    let refused = 0;
    for (let seed = 1; seed < 20; seed++) if (readGlyph(noise(seed)) === null) refused++;
    expect(refused).toBeGreaterThan(15);
  });

  it("refuses a blank bitmap", () => {
    expect(readGlyph(new Uint8Array(GLYPH_SIZE * GLYPH_SIZE))).toBeNull();
  });
});
