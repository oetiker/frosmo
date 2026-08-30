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
    // Eight of thirteen, asked to choose among all 36. The 36-class model this
    // one replaced managed nine, and got the same Y wrong; the sheet is clipped
    // along its top edge, so several of these are half a glyph. This is a
    // regression guard, not a target — the number to improve is here.
    let right = 0;
    for (const c of characters) if (readGlyph(bitmap(c.bits))?.char === c.label) right++;
    expect(right).toBeGreaterThanOrEqual(8);
  });

  it("does not invent characters where there are none", () => {
    // Nineteen of twenty-three refused outright, and the four that get through
    // do so at 0.55 confidence or less, where the reader's own thresholds take
    // them. Without a reject class this number is zero — asked to name a border
    // fragment a 36-way net names one, and at 1.00 confidence.
    const refused = junk.filter((c) => readGlyph(bitmap(c.bits)) === null).length;
    expect(refused).toBeGreaterThanOrEqual(19);
    const loud = junk.filter((c) => (readGlyph(bitmap(c.bits))?.confidence ?? 0) > 0.6);
    expect(loud).toHaveLength(0);
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
