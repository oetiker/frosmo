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
import sheet from "./fixtures/rig-sheet.json";

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

  it("still lets one border fragment through, which is why tiles are found first", () => {
    // One upright piece of a tile's printed border reads as a letter at high
    // confidence. It is not a mistake in the ordinary sense: after the crop is
    // normalised, an upright stroke and a letter I are the same bitmap. Which
    // letter it lands on is not worth pinning — the point is that a model given
    // loose ink cannot win this, and teaching it to refuse uprights would cost
    // every real I on the sheet.
    //
    // The answer is not in the model at all. tile-finder.ts locates the tiles
    // first, and then nothing outside one is ever a candidate. This path is the
    // fallback for tiles with no frame to find, and there this cost stands.
    const loud = junk
      .map((c) => readGlyph(bitmap(c.bits)))
      .filter((r) => r !== null && r.confidence > 0.6);
    expect(loud.length).toBeLessThanOrEqual(1);
  });
});

describe("the whole printed sheet, on the rig", () => {
  /*
   * The capture the first one should have been: every tile inside the play
   * area, so all 36 characters are whole rather than clipped by the board edge.
   * Labelled from each candidate's position in the sheet's own layout — never
   * from what the recogniser said — so the test is not marking its own work.
   *
   * It exists because of what it caught. Against the model as first shipped it
   * scores 24 of 36, and the twelve it drops are not random: they are the ones
   * with the least ink. Chief among them A, which was read perfectly every time
   * and thrown away every time by a runner-up search that made class 0 its own
   * runner-up. No other character in the alphabet could hit that.
   */
  const chars = sheet.candidates.filter((c) => c.label !== "");
  const junk = sheet.candidates.filter((c) => c.label === "");

  it("holds every character on the sheet", () => {
    expect(chars).toHaveLength(36);
    expect(chars.map((c) => c.label).sort().join("")).toBe(
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    );
  });

  it("reads all but a couple of them", () => {
    const wrong = chars.filter((c) => readGlyph(bitmap(c.bits))?.char !== c.label);
    expect(wrong.length).toBeLessThanOrEqual(2);
  });

  it("reads A, and gives it a margin a caller will accept", () => {
    const a = chars.find((c) => c.label === "A")!;
    const r = readGlyph(bitmap(a.bits))!;
    expect(r.char).toBe("A");
    // TileReader's own floor. A read this confidently must survive it.
    expect(r.margin).toBeGreaterThanOrEqual(0.12);
    expect(r.confidence).toBeGreaterThanOrEqual(0.45);
  });

  it("still refuses the border fragments among them", () => {
    const refused = junk.filter((c) => readGlyph(bitmap(c.bits)) === null).length;
    expect(refused / junk.length).toBeGreaterThanOrEqual(0.6);
  });
});
