import { describe, expect, it } from "vitest";
import type { Blob } from "../src/vision/blobs.js";
import { createRectifiedFrame, type RectifiedFrame } from "../src/vision/rectify.js";
import { TileReader } from "../src/vision/tile-reader.js";
import fixture from "./fixtures/rig-candidates.json";

const W = 320;
const H = 240;
/** Blob size the shape filter accepts, and the glyph is painted to match. */
const BW = 16;
const BH = 20;

/**
 * A character, photographed on the rig, as a 24x24 bitmap.
 *
 * Painting a real letterform matters: the recogniser can refuse now, and it
 * refuses a synthetic stand-in — which is the correct answer, and useless for
 * testing the reader's own budget and caching.
 */
const GLYPH = (() => {
  const hex = fixture.candidates.find((c) => c.label === "W")!.bits;
  const out = new Uint8Array(24 * 24);
  for (let i = 0; i < hex.length; i++) {
    const v = parseInt(hex[i], 16);
    out[i * 4] = (v >> 3) & 1;
    out[i * 4 + 1] = (v >> 2) & 1;
    out[i * 4 + 2] = (v >> 1) & 1;
    out[i * 4 + 3] = v & 1;
  }
  return out;
})();

function paper(): RectifiedFrame {
  const f = createRectifiedFrame({ w: W, h: H });
  for (let i = 0; i < W * H; i++) {
    f.rgba[i * 4] = f.rgba[i * 4 + 1] = f.rgba[i * 4 + 2] = 235;
    f.gray[i] = 235;
  }
  return f;
}

/** Paint the glyph into a BW x BH box centred on (cx, cy). */
function stamp(f: RectifiedFrame, cx: number, cy: number): void {
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      const sx = Math.min(23, Math.floor((x / BW) * 24));
      const sy = Math.min(23, Math.floor((y / BH) * 24));
      const px = Math.round(cx - BW / 2) + x;
      const py = Math.round(cy - BH / 2) + y;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const v = GLYPH[sy * 24 + sx] ? 30 : 235;
      const i = py * W + px;
      f.rgba[i * 4] = f.rgba[i * 4 + 1] = f.rgba[i * 4 + 2] = v;
      f.gray[i] = v;
    }
  }
}

/** A blob the shape filter accepts, matching what stamp() paints. */
function blob(id: number, cx: number, cy: number): Blob {
  return {
    id,
    area: Math.round(BW * BH * 0.5),
    cx,
    cy,
    minX: Math.round(cx - BW / 2),
    minY: Math.round(cy - BH / 2),
    maxX: Math.round(cx - BW / 2) + BW - 1,
    maxY: Math.round(cy - BH / 2) + BH - 1,
    r: 0,
    g: 0,
    b: 0,
    angle: 0,
    elongation: 1.2,
  };
}

/** n tiles in a row, far enough apart that no crop reaches its neighbour. */
function row(n: number): { frame: RectifiedFrame; blobs: Blob[] } {
  const frame = paper();
  const blobs: Blob[] = [];
  for (let i = 0; i < n; i++) {
    const cx = 20 + i * 30;
    stamp(frame, cx, 60);
    blobs.push(blob(i, cx, 60));
  }
  return { frame, blobs };
}

/** Accept whatever the model says, so the test measures the reader, not the net. */
const permissive = { minConfidence: 0, minMargin: 0 };

describe("TileReader", () => {
  it("recognises no more than its budget of new candidates per frame", () => {
    // Recognition costs about a millisecond per glyph and a sheet offers
    // thirty; doing them all in one frame would spend the entire budget.
    const reader = new TileReader();
    const { frame, blobs } = row(10);
    expect(reader.read(frame, blobs, { ...permissive, budget: 3 })).toHaveLength(3);
  });

  it("clears the backlog over the next frames", () => {
    const reader = new TileReader();
    const { frame, blobs } = row(10);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) counts[i] = reader.read(frame, blobs, { ...permissive, budget: 3 }).length;
    // Three more each frame, and the ones already read keep being reported.
    expect(counts).toEqual([3, 6, 9, 10]);
  });

  it("costs nothing once the tiles are known", () => {
    // The steady state: tiles lie still, and nothing is recognised again.
    const reader = new TileReader();
    const { frame, blobs } = row(4);
    for (let i = 0; i < 4; i++) reader.read(frame, blobs, { ...permissive, budget: 4 });
    const before = reader.cached;
    expect(reader.read(frame, blobs, { ...permissive, budget: 0 })).toHaveLength(4);
    expect(reader.cached).toBe(before);
  });

  it("tolerates a tile jittering by a pixel", () => {
    // Mask edges move slightly between frames; a cache key that changed with
    // the jitter would never hit and the budget would be spent every frame.
    const reader = new TileReader();
    const { frame } = row(1);
    reader.read(frame, [blob(0, 20, 60)], { ...permissive, budget: 1 });
    const cached = reader.cached;
    expect(reader.read(frame, [blob(0, 21, 61)], { ...permissive, budget: 0 })).toHaveLength(1);
    expect(reader.cached).toBe(cached);
  });

  it("reads a tile that has genuinely moved somewhere new", () => {
    const reader = new TileReader();
    const frame = paper();
    stamp(frame, 100, 60);
    stamp(frame, 240, 180);
    reader.read(frame, [blob(0, 100, 60)], { ...permissive, budget: 1 });
    expect(reader.read(frame, [blob(0, 240, 180)], { ...permissive, budget: 0 })).toHaveLength(0);
    expect(reader.read(frame, [blob(0, 240, 180)], { ...permissive, budget: 1 })).toHaveLength(1);
  });

  it("ignores blobs that are not glyph-shaped", () => {
    const { frame } = row(1);
    const wide = blob(0, 100, 60);
    wide.minX = 10;
    wide.maxX = 200;
    wide.area = 400;
    expect(new TileReader().read(frame, [wide], { ...permissive, budget: 4 })).toHaveLength(0);
  });

  it("forgets everything on reset", () => {
    const reader = new TileReader();
    const { frame, blobs } = row(3);
    reader.read(frame, blobs, { ...permissive, budget: 3 });
    expect(reader.cached).toBeGreaterThan(0);
    reader.reset();
    expect(reader.cached).toBe(0);
  });

  it("does not let junk eat the budget frame after frame", () => {
    // A real sheet offers far more junk than letters: border fragments, token
    // rims, specks. If every one costs a slot every frame, the letters behind
    // them are never reached and the board looks empty.
    const frame = paper();
    stamp(frame, 250, 60);
    const junk = Array.from({ length: 6 }, (_, i) => blob(i, 20 + i * 25, 60));
    const real = blob(99, 250, 60);
    const reader = new TileReader();

    // Junk comes first, so on the first frame it takes the whole budget.
    expect(reader.read(frame, [...junk, real], { ...permissive, budget: 6 })).toHaveLength(0);
    // Second frame: the refusals are remembered, so the budget reaches the letter.
    expect(reader.read(frame, [...junk, real], { ...permissive, budget: 6 })).toHaveLength(1);
  });

  it("looks again when something is put down where it refused before", () => {
    // A refusal is a claim about a place, and places change. A blob that grows
    // is re-read, or a tile laid on top of a speck would stay invisible for as
    // long as the refusal stood.
    const frame = paper();
    const reader = new TileReader();
    // Smaller than a tile but still glyph-shaped, so the shape filter passes it
    // on and the refusal is the model's, not the filter's.
    const speck = blob(0, 100, 60);
    speck.minX += 3;
    speck.maxX -= 3;
    speck.minY += 2;
    speck.maxY -= 2;
    speck.area = 80;
    expect(reader.read(frame, [speck], { ...permissive, budget: 1 })).toHaveLength(0);

    stamp(frame, 100, 60);
    expect(reader.read(frame, [blob(0, 100, 60)], { ...permissive, budget: 1 })).toHaveLength(1);
  });

  it("covers every tile on a jittering board, not only the fattest ones", () => {
    // The failure this exists for, with its real mechanism.
    //
    // labelBlobs returns candidates largest first, and ink area is very nearly
    // a measure of how fat a letter is. Meanwhile a tile's centroid wanders a
    // few pixels between frames as the mask edges move. Cache the reading
    // against a grid cell and that wander is a miss every time it crosses a
    // boundary — so the budget goes on re-reading whatever is at the front of
    // the queue, which is always M, W and B, and A, I, E, F, T and 1 sit at the
    // back and are never reached. On the rig that showed up as the board
    // reporting exactly the two dozen fattest glyphs on the sheet and no others.
    const reader = new TileReader();
    const frame = paper();
    const at: Array<{ cx: number; cy: number }> = [];
    for (let i = 0; i < 20; i++) {
      const cx = 20 + (i % 10) * 30;
      const cy = 40 + Math.floor(i / 10) * 40;
      stamp(frame, cx, cy);
      at.push({ cx, cy });
    }

    const seen = new Set<number>();
    for (let f = 0; f < 6; f++) {
      // Three pixels, which is enough to cross a five-pixel cell about half the
      // time, and nothing a real board does not do.
      const wobble = [0, 3, -3, 1, -2, 2][f];
      const blobs = at.map((p, i) => {
        const b = blob(i, p.cx + wobble, p.cy + (i % 2 ? wobble : -wobble));
        b.area = 400 - i * 10; // descending, the way the pipeline hands them over
        return b;
      });
      for (const r of reader.read(frame, blobs, { ...permissive, budget: 4 })) {
        seen.add(at.findIndex((p) => Math.abs(p.cx - r.cx) < 6 && Math.abs(p.cy - r.cy) < 6));
      }
    }
    expect(seen.has(-1)).toBe(false);
    expect(seen.size).toBe(20);
  });

  it("keeps hitting the cache while a tile jitters across a cell boundary", () => {
    const reader = new TileReader();
    const frame = paper();
    const at = Array.from({ length: 8 }, (_, i) => 20 + i * 30);
    for (const cx of at) stamp(frame, cx, 60);
    const blobs = at.map((cx, i) => blob(i, cx, 60));
    for (let f = 0; f < 3; f++) reader.read(frame, blobs, { ...permissive, budget: 4 });

    // Everything is known by now. Move each tile three pixels and ask for no
    // budget at all: every reading has to come from the cache or not at all.
    const jittered = at.map((cx, i) => blob(i, cx + 3, 60 - 3));
    expect(reader.read(frame, jittered, { ...permissive, budget: 0 })).toHaveLength(8);
  });

  it("only reports readings it is confident about", () => {
    // The default thresholds exist so a game is told nothing rather than told
    // something wrong; a blank board must produce no letters.
    const blank = createRectifiedFrame({ w: W, h: H });
    blank.gray.fill(240);
    const blobs = Array.from({ length: 6 }, (_, i) => blob(i, 20 + i * 30, 60));
    expect(new TileReader().read(blank, blobs, { budget: 6 })).toHaveLength(0);
  });
});
