/**
 * The recogniser against one real capture from the rig.
 *
 * Synthetic validation says the model reads letters well, and it does — but it
 * is graded on samples the trainer itself produced, and a model can only be as
 * honest as the degradations someone thought to simulate. This fixture is the
 * other kind of evidence: every candidate the tile path actually pulled out of
 * a photograph of the app's own printout, lying on a table under a mirror,
 * hand-labelled. Thirteen are characters. The other twenty-three are fragments
 * of the tiles' printed borders, the rims and bodies of colour tokens, and
 * print speckle — and every one of them passed the shape filter, which is the
 * whole reason the model needs to be able to refuse.
 */

import { describe, expect, it } from "vitest";
import { readGlyph } from "../src/vision/glyph-net.js";
import fixture from "./fixtures/rig-candidates.json";

const N = fixture.size;

function bitmap(hex: string): Uint8Array {
  const out = new Uint8Array(N * N);
  for (let i = 0; i < hex.length; i++) {
    const v = parseInt(hex[i], 16);
    out[i * 4] = (v >> 3) & 1;
    out[i * 4 + 1] = (v >> 2) & 1;
    out[i * 4 + 2] = (v >> 1) & 1;
    out[i * 4 + 3] = v & 1;
  }
  return out;
}

const characters = fixture.candidates.filter((c) => c.label !== "");
const junk = fixture.candidates.filter((c) => c.label === "");

describe("one capture from the rig", () => {
  it("has the shape of the problem: mostly junk", () => {
    expect(characters).toHaveLength(13);
    expect(junk).toHaveLength(23);
  });

  it("reads the characters that are really there", () => {
    // Ten of thirteen, asked to choose among all 36; the 36-class model that
    // could not refuse managed nine. The sheet is clipped along its top edge,
    // so several of these are half a glyph. A regression guard, not a target.
    let right = 0;
    for (const c of characters) if (readGlyph(bitmap(c.bits))?.char === c.label) right++;
    expect(right).toBeGreaterThanOrEqual(10);
  });

  it("does not invent characters where there are none", () => {
    // Twenty-two of twenty-three refused outright. Without a reject class this
    // number is zero — asked to name a border fragment, a 36-way net names one,
    // and at 1.00 confidence.
    const refused = junk.filter((c) => readGlyph(bitmap(c.bits)) === null).length;
    expect(refused).toBeGreaterThanOrEqual(22);
  });

  it("still reads one border fragment as an I, and that is not fixable here", () => {
    // The one that gets through is an upright piece of a tile's printed border,
    // read as I at high confidence. It is not a mistake in the ordinary sense:
    // after the crop is normalised, an upright stroke and a letter I are the
    // same bitmap. Training the net to refuse it would cost every real I on the
    // sheet, which is a worse trade than one phantom. What separates them is
    // context — an I sits alone inside a tile, a border does not — and context
    // is not available at this layer. Recorded here so the next person does not
    // spend an afternoon on it.
    const loud = junk
      .map((c) => readGlyph(bitmap(c.bits)))
      .filter((r) => r !== null && r.confidence > 0.6);
    expect(loud).toHaveLength(1);
    expect(loud[0]!.char).toBe("I");
  });

  it("still reads the letters when a game restricts the alphabet", () => {
    const letters = characters.filter((c) => /[A-Z]/.test(c.label));
    let right = 0;
    for (const c of letters) {
      if (readGlyph(bitmap(c.bits), "ABCDEFGHIJKLMNOPQRSTUVWXYZ")?.char === c.label) right++;
    }
    expect(right).toBeGreaterThanOrEqual(letters.length - 1);
  });
});
