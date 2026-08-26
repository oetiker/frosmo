import { describe, expect, it } from "vitest";
import { labelBlobs } from "../src/vision/blobs.js";
import { GLYPH_SIZE, type GlyphAtlas } from "../src/vision/glyph.js";
import { OccupancyDetector } from "../src/vision/occupancy.js";
import { createRectifiedFrame, type RectifiedFrame } from "../src/vision/rectify.js";
import { detectTiles, foldAngle } from "../src/vision/tiles.js";

const W = 200;
const H = 150;

function blank(): RectifiedFrame {
  const f = createRectifiedFrame({ w: W, h: H });
  paint(f, () => 190);
  return f;
}

function paint(f: RectifiedFrame, at: (x: number, y: number) => number): void {
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const y = (i - x) / W;
    const v = at(x, y);
    f.rgba[i * 4] = f.rgba[i * 4 + 1] = f.rgba[i * 4 + 2] = v;
    f.rgba[i * 4 + 3] = 255;
    f.gray[i] = v;
  }
}

/** A white tile with a dark mark on it, drawn from a small pixel grid. */
function drawTile(f: RectifiedFrame, cx: number, cy: number, size: number, rows: string[]): void {
  const half = size / 2;
  const cell = size / rows.length;
  for (let y = Math.round(cy - half); y < cy + half; y++) {
    for (let x = Math.round(cx - half); x < cx + half; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const gx = Math.floor((x - (cx - half)) / cell);
      const gy = Math.floor((y - (cy - half)) / cell);
      const inked = rows[gy]?.[gx] === "#";
      const v = inked ? 28 : 246;
      const i = y * W + x;
      f.rgba[i * 4] = f.rgba[i * 4 + 1] = f.rgba[i * 4 + 2] = v;
      f.gray[i] = v;
    }
  }
}

/** Build an atlas from the same pixel grids the tiles are drawn from. */
function atlasFrom(shapes: Record<string, string[]>): GlyphAtlas {
  const chars = Object.keys(shapes);
  const templates = chars.map((ch) => {
    const rows = shapes[ch];
    const out = new Uint8Array(GLYPH_SIZE * GLYPH_SIZE);
    const cell = GLYPH_SIZE / rows.length;
    for (let y = 0; y < GLYPH_SIZE; y++) {
      for (let x = 0; x < GLYPH_SIZE; x++) {
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        if (rows[gy]?.[gx] === "#") out[y * GLYPH_SIZE + x] = 1;
      }
    }
    return out;
  });
  return { chars, templates, font: "test" };
}

const SHAPES = {
  L: ["#...", "#...", "#...", "####"],
  T: ["####", ".#..", ".#..", ".#.."],
};

function findTiles(place: (f: RectifiedFrame) => void) {
  const detector = new OccupancyDetector(W, H, { denoise: 1, drift: 0 });
  for (let i = 0; i < 6; i++) detector.learn(blank());

  const scene = blank();
  place(scene);
  detector.detect(scene);

  const { blobs } = labelBlobs(detector.mask, { rgba: scene.rgba, minArea: 60 });
  return detectTiles(scene, blobs, atlasFrom(SHAPES), { minArea: 100 });
}

describe("detectTiles", () => {
  it("reads two tiles and keeps them in place", () => {
    const tiles = findTiles((f) => {
      drawTile(f, 60, 70, 40, SHAPES.L);
      drawTile(f, 140, 70, 40, SHAPES.T);
    }).sort((a, b) => a.cx - b.cx);

    expect(tiles.map((t) => t.char)).toEqual(["L", "T"]);
    expect(tiles[0].cx).toBeGreaterThan(45);
    expect(tiles[0].cx).toBeLessThan(75);
    expect(tiles[1].cx).toBeGreaterThan(125);
  });

  it("reads a tile that is not the same size as the others", () => {
    const tiles = findTiles((f) => {
      drawTile(f, 55, 60, 30, SHAPES.L);
      drawTile(f, 140, 80, 52, SHAPES.T);
    }).sort((a, b) => a.cx - b.cx);
    expect(tiles.map((t) => t.char)).toEqual(["L", "T"]);
  });

  it("reports a margin over the runner-up for every tile it reads", () => {
    const tiles = findTiles((f) => drawTile(f, 100, 75, 44, SHAPES.L));
    expect(tiles).toHaveLength(1);
    expect(tiles[0].margin).toBeGreaterThan(0);
    expect(tiles[0].score).toBeGreaterThan(0.4);
  });

  it("ignores a blob that is not tile-shaped", () => {
    // A pen lying on the table: right darkness, wrong geometry.
    const tiles = findTiles((f) => {
      for (let y = 70; y < 76; y++) {
        for (let x = 20; x < 180; x++) {
          const i = y * W + x;
          f.rgba[i * 4] = f.rgba[i * 4 + 1] = f.rgba[i * 4 + 2] = 30;
          f.gray[i] = 30;
        }
      }
    });
    expect(tiles).toHaveLength(0);
  });

  it("finds nothing on an empty board", () => {
    expect(findTiles(() => undefined)).toHaveLength(0);
  });
});

describe("foldAngle", () => {
  it("folds a square's ambiguous axis into a quarter turn", () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(foldAngle(deg(0))).toBeCloseTo(0, 6);
    expect(foldAngle(deg(10))).toBeCloseTo(deg(10), 6);
    expect(foldAngle(deg(80))).toBeCloseTo(deg(-10), 6);
    expect(foldAngle(deg(95))).toBeCloseTo(deg(5), 6);
  });

  it("always lands inside plus or minus 45 degrees", () => {
    for (let d = -180; d <= 180; d += 7) {
      const folded = foldAngle((d * Math.PI) / 180);
      expect(Math.abs(folded)).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
    }
  });
});
