/**
 * Finding the card with nothing known.
 *
 * Every case here is a photograph the app might actually be handed: the card
 * square on, at an angle, upside down on a table somebody walked around, and
 * seen through a mirror, which is what a reflector rig does to everything.
 */
import { describe, expect, it } from "vitest";
import { findCard } from "../src/vision/card-finder.js";
import { CARD_ASPECT } from "../src/vision/card.js";
import { drawCard } from "./helpers/card.js";

const W = 640;
const H = 480;

/**
 * Place the card into the frame, with optional turn, mirror and perspective.
 *
 * The card keeps its proportions when it is turned — a card on its side is
 * portrait, not a squashed landscape one — because a test that squashed it
 * would be checking the finder against a card no printer produces, and the
 * rings would arrive as ellipses far flatter than perspective ever makes them.
 */
function placer(opts: { turn?: 0 | 1 | 2 | 3; mirror?: boolean; tilt?: number } = {}) {
  const turn = opts.turn ?? 0;
  const tilt = opts.tilt ?? 0;
  const cardH = 1 / CARD_ASPECT;
  return (u: number, v: number) => {
    // Perspective first, in the card's own frame: the far edge is narrower,
    // which is what a camera on a stand looking down at a table produces.
    const shrink = 1 - tilt * (1 - v);
    // u and v both run 0-1 across the card; the card is 1 wide and cardH tall.
    let a = ((opts.mirror ? 1 - u : u) - 0.5) * shrink;
    let b = (v - 0.5) * cardH;
    // Turn about the centre, in proportional units.
    for (let t = 0; t < turn; t++) {
      const na = -b;
      b = a;
      a = na;
    }
    const spanX = turn % 2 ? cardH : 1;
    const spanY = turn % 2 ? 1 : cardH;
    const scale = Math.min((W - 120) / spanX, (H - 80) / spanY);
    return { x: W / 2 + a * scale, y: H / 2 + b * scale };
  };
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 6) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= tol;

describe("findCard", () => {
  it("finds a card lying square on", () => {
    const card = drawCard(W, H, placer());
    const seen = findCard(card.gray, W, H);
    expect(seen).not.toBeNull();
    for (let i = 0; i < 4; i++) expect(near(seen!.quad[i], card.marks[i])).toBe(true);
    expect(seen!.mirrored).toBe(false);
  });

  it("finds it at an angle, which is how a camera on a stand sees a table", () => {
    const card = drawCard(W, H, placer({ tilt: 0.28 }));
    const seen = findCard(card.gray, W, H);
    expect(seen).not.toBeNull();
    for (let i = 0; i < 4; i++) expect(near(seen!.quad[i], card.marks[i], 10)).toBe(true);
  });

  it("knows which way up it is, from the fifth mark", () => {
    // Four marks at the corners of a rectangle look identical upside down. The
    // key ring is what says otherwise, and the corners must come back in card
    // order however the card was laid down.
    for (const turn of [0, 1, 2, 3] as const) {
      const card = drawCard(W, H, placer({ turn }));
      const seen = findCard(card.gray, W, H);
      expect(seen, `turn ${turn}`).not.toBeNull();
      for (let i = 0; i < 4; i++) {
        expect(near(seen!.quad[i], card.marks[i], 8), `turn ${turn} corner ${i}`).toBe(true);
      }
    }
  });

  it("notices a mirror, because a reflector rig is one", () => {
    const card = drawCard(W, H, placer({ mirror: true }));
    const seen = findCard(card.gray, W, H);
    expect(seen).not.toBeNull();
    expect(seen!.mirrored).toBe(true);
    for (let i = 0; i < 4; i++) expect(near(seen!.quad[i], card.marks[i], 8)).toBe(true);
  });

  it("survives a lens that is not quite in focus", () => {
    const card = drawCard(W, H, placer({ tilt: 0.15 }), { blur: 2 });
    const seen = findCard(card.gray, W, H);
    expect(seen).not.toBeNull();
    for (let i = 0; i < 4; i++) expect(near(seen!.quad[i], card.marks[i], 10)).toBe(true);
  });

  it("says nothing rather than guessing when there is no card", () => {
    const gray = new Uint8ClampedArray(W * H).fill(200);
    for (let y = 100; y < 300; y++) for (let x = 100; x < 400; x++) gray[y * W + x] = 240;
    expect(findCard(gray, W, H)).toBeNull();
  });
});
