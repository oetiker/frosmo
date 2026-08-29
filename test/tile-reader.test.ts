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

  it("only reports readings it is confident about", () => {
    // The default thresholds exist so a game is told nothing rather than told
    // something wrong; a blank board must produce no letters.
    const reader = new TileReader();
    const blank = createRectifiedFrame({ w: W, h: H });
    blank.gray.fill(240);
    expect(reader.read(blank, row(6), { budget: 6 })).toHaveLength(0);
  });
});
