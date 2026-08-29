import { describe, expect, it } from "vitest";
import type { Blob } from "../src/vision/blobs.js";
import { createRectifiedFrame, type RectifiedFrame } from "../src/vision/rectify.js";
import { TileReader } from "../src/vision/tile-reader.js";

const W = 320;
const H = 240;

function frame(): RectifiedFrame {
  const f = createRectifiedFrame({ w: W, h: H });
  // Paper with a dark mark in the middle of every candidate, so a crop taken
  // anywhere has ink in it to normalise.
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const y = (i - x) / W;
    const v = (x % 20 < 6 && y % 20 < 9) ? 30 : 230;
    f.rgba[i * 4] = f.rgba[i * 4 + 1] = f.rgba[i * 4 + 2] = v;
    f.gray[i] = v;
  }
  return f;
}

/** A blob the shape filter accepts: letter-sized, solid enough, upright. */
function blob(id: number, cx: number, cy: number): Blob {
  const bw = 9;
  const bh = 13;
  return {
    id,
    area: Math.round(bw * bh * 0.5),
    cx,
    cy,
    minX: Math.round(cx - bw / 2),
    minY: Math.round(cy - bh / 2),
    maxX: Math.round(cx + bw / 2),
    maxY: Math.round(cy + bh / 2),
    r: 0,
    g: 0,
    b: 0,
    angle: 0,
    elongation: 1.2,
  };
}

const row = (n: number) => Array.from({ length: n }, (_, i) => blob(i, 30 + i * 25, 60));
/** Accept whatever the model says, so the test measures the reader, not the net. */
const permissive = { minConfidence: 0, minMargin: 0 };

describe("TileReader", () => {
  it("recognises no more than its budget of new candidates per frame", () => {
    // Recognition costs about a millisecond per glyph and a sheet offers
    // thirty; doing them all in one frame would spend the entire budget.
    const reader = new TileReader();
    const read = reader.read(frame(), row(10), { ...permissive, budget: 3 });
    expect(read.length).toBe(3);
  });

  it("clears the backlog over the next frames", () => {
    const reader = new TileReader();
    const f = frame();
    const blobs = row(10);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) counts[i] = reader.read(f, blobs, { ...permissive, budget: 3 }).length;
    // Three more each frame, and the ones already read keep being reported.
    expect(counts).toEqual([3, 6, 9, 10]);
  });

  it("costs nothing once the tiles are known", () => {
    // The steady state: tiles lie still, and nothing is recognised again.
    const reader = new TileReader();
    const f = frame();
    const blobs = row(4);
    for (let i = 0; i < 4; i++) reader.read(f, blobs, { ...permissive, budget: 4 });
    const before = reader.cached;
    const read = reader.read(f, blobs, { ...permissive, budget: 0 });
    expect(read).toHaveLength(4);
    expect(reader.cached).toBe(before);
  });

  it("tolerates a tile jittering by a pixel", () => {
    // Mask edges move slightly between frames; a cache key that changed with
    // the jitter would never hit and the budget would be spent every frame.
    const reader = new TileReader();
    const f = frame();
    reader.read(f, [blob(0, 100, 60)], { ...permissive, budget: 1 });
    const cached = reader.cached;
    const again = reader.read(f, [blob(0, 101, 61)], { ...permissive, budget: 0 });
    expect(again).toHaveLength(1);
    expect(reader.cached).toBe(cached);
  });

  it("reads a tile that has genuinely moved somewhere new", () => {
    const reader = new TileReader();
    const f = frame();
    reader.read(f, [blob(0, 100, 60)], { ...permissive, budget: 1 });
    const moved = reader.read(f, [blob(0, 240, 180)], { ...permissive, budget: 0 });
    expect(moved).toHaveLength(0); // no budget left this frame
    expect(reader.read(f, [blob(0, 240, 180)], { ...permissive, budget: 1 })).toHaveLength(1);
  });

  it("ignores blobs that are not glyph-shaped", () => {
    const reader = new TileReader();
    const wide = blob(0, 100, 60);
    wide.minX = 10;
    wide.maxX = 200;
    wide.area = 400;
    expect(reader.read(frame(), [wide], { ...permissive, budget: 4 })).toHaveLength(0);
  });

  it("forgets everything on reset", () => {
    const reader = new TileReader();
    reader.read(frame(), row(3), { ...permissive, budget: 3 });
    expect(reader.cached).toBeGreaterThan(0);
    reader.reset();
    expect(reader.cached).toBe(0);
  });

  it("does not let junk eat the budget frame after frame", () => {
    // A real sheet offers far more junk than letters: border fragments, token
    // rims, specks. If every one costs a slot every frame, the letters behind
    // them are never reached and the board looks empty.
    const reader = new TileReader();
    const f = frame();
    // Blank the left half; blobs there have nothing in them to read.
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W / 2; x++) {
        f.gray[y * W + x] = 240;
        const i = (y * W + x) * 4;
        f.rgba[i] = f.rgba[i + 1] = f.rgba[i + 2] = 240;
      }
    const junk = Array.from({ length: 6 }, (_, i) => blob(i, 20 + i * 20, 60));
    const real = blob(99, 250, 60);

    // Junk comes first, so on the first frame it takes the whole budget.
    expect(reader.read(f, [...junk, real], { ...permissive, budget: 6 })).toHaveLength(0);
    // Second frame: the refusals are remembered, so the budget reaches the letter.
    expect(reader.read(f, [...junk, real], { ...permissive, budget: 6 })).toHaveLength(1);
  });

  it("looks again when something is put down where it refused before", () => {
    // A refusal is a claim about a place, and places change. A blob that grows
    // is re-read, or a tile laid on top of a speck would stay invisible for as
    // long as the refusal stood.
    const reader = new TileReader();
    const f = frame();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W / 2; x++) {
        f.gray[y * W + x] = 240;
        const i = (y * W + x) * 4;
        f.rgba[i] = f.rgba[i + 1] = f.rgba[i + 2] = 240;
      }

    const speck = blob(0, 100, 60);
    expect(reader.read(f, [speck], { ...permissive, budget: 1 })).toHaveLength(0);

    // Someone lays a tile there: ink appears and the blob grows with it.
    for (let y = 48; y < 72; y++)
      for (let x = 92; x < 108; x++) {
        const v = x < 96 || y < 52 ? 30 : 240;
        f.gray[y * W + x] = v;
        const i = (y * W + x) * 4;
        f.rgba[i] = f.rgba[i + 1] = f.rgba[i + 2] = v;
      }
    const tile = blob(0, 100, 60);
    tile.minX -= 4;
    tile.maxX += 4;
    tile.minY -= 4;
    tile.maxY += 4;
    tile.area = Math.round((tile.maxX - tile.minX + 1) * (tile.maxY - tile.minY + 1) * 0.5);
    expect(reader.read(f, [tile], { ...permissive, budget: 1 })).toHaveLength(1);
  });

  it("only reports readings it is confident about", () => {
    // The default thresholds exist so a game is told nothing rather than told
    // something wrong; a blank board must produce no letters.
    const reader = new TileReader();
    const blank = createRectifiedFrame({ w: W, h: H });
    blank.gray.fill(240);
    expect(reader.read(blank, row(6), { budget: 6 })).toHaveLength(0);
  });
});
