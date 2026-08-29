import { describe, expect, it } from "vitest";
import { labelBlobs } from "../src/vision/blobs.js";
import { GLYPH_SIZE, type GlyphAtlas } from "../src/vision/glyph.js";
import { createMask } from "../src/vision/mask.js";
import { createRectifiedFrame, type RectifiedFrame } from "../src/vision/rectify.js";
import {
  detectTiles,
  foldAngle,
  glyphCandidate,
  glyphLimits,
  glyphMinArea,
  GLYPH_LIMITS,
} from "../src/vision/tiles.js";

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

/**
 * Find tiles the way the pipeline now does: from ink, not from occupancy.
 *
 * A printed tile on a white sheet is not an object on the table — its body
 * matches the paper it is printed on, and only the glyph is dark. So the mask
 * here is the dark marks, which is what the ink detector produces, and the
 * blobs are letters rather than tile bodies.
 */
function findTiles(place: (f: RectifiedFrame) => void) {
  const scene = blank();
  place(scene);

  const ink = createMask(W, H);
  for (let i = 0; i < W * H; i++) ink.data[i] = scene.gray[i] < 128 ? 1 : 0;

  const { blobs } = labelBlobs(ink, { rgba: scene.rgba, minArea: glyphMinArea(W, H) });
  return detectTiles(scene, blobs, atlasFrom(SHAPES));
}

describe("detectTiles", () => {
  it("reads two tiles and keeps them in place", () => {
    const tiles = findTiles((f) => {
      drawTile(f, 60, 70, 16, SHAPES.L);
      drawTile(f, 140, 70, 16, SHAPES.T);
    }).sort((a, b) => a.cx - b.cx);

    expect(tiles.map((t) => t.char)).toEqual(["L", "T"]);
    expect(tiles[0].cx).toBeGreaterThan(45);
    expect(tiles[0].cx).toBeLessThan(75);
    expect(tiles[1].cx).toBeGreaterThan(125);
  });

  it("reads a tile that is not the same size as the others", () => {
    const tiles = findTiles((f) => {
      drawTile(f, 55, 60, 13, SHAPES.L);
      drawTile(f, 140, 80, 19, SHAPES.T);
    }).sort((a, b) => a.cx - b.cx);
    expect(tiles.map((t) => t.char)).toEqual(["L", "T"]);
  });

  it("reports a margin over the runner-up for every tile it reads", () => {
    const tiles = findTiles((f) => drawTile(f, 100, 75, 16, SHAPES.L));
    expect(tiles).toHaveLength(1);
    expect(tiles[0].margin).toBeGreaterThan(0);
    expect(tiles[0].score).toBeGreaterThan(0.4);
  });

  it("ignores a mark that is not glyph-shaped", () => {
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

describe("glyphCandidate, against shapes measured from a real capture", () => {
  const blob = (bw: number, bh: number, fill: number) => {
    const area = Math.round(bw * bh * fill);
    return { id: 1, area, cx: 0, cy: 0, minX: 0, minY: 0, maxX: bw - 1, maxY: bh - 1, r: 0, g: 0, b: 0, angle: 0, elongation: 1 };
  };

  it("accepts the letters as they actually appeared", () => {
    // Straight from the capture: area, bounding box and fill of real letters.
    for (const [bw, bh, fill] of [
      [9, 11, 0.62],
      [8, 16, 0.51],
      [16, 18, 0.48],
      [13, 18, 0.55],
      [10, 7, 0.64],
      [5, 17, 0.29],
    ] as const) {
      expect(glyphCandidate(blob(bw, bh, fill))).toBe("ok");
    }
  });

  it("rejects a tile's printed border", () => {
    // A big hollow ring. This is the shape that has to reject itself, because
    // it surrounds the very glyph we want and would otherwise be read instead.
    // Rejected for being a long hollow box. Which rule catches it first is an
    // implementation detail; that it never reaches the recogniser is not.
    expect(glyphCandidate(blob(87, 40, 0.12))).not.toBe("ok");
    // This one isolates the fill test: square enough, small enough, but hollow.
    expect(glyphCandidate(blob(34, 27, 0.16))).toBe("hollow");
  });

  it("rejects a line of caption text", () => {
    expect(glyphCandidate(blob(36, 10, 0.47))).toBe("wrong-shape");
  });

  it("rejects sensor speckle", () => {
    expect(glyphCandidate(blob(3, 3, 0.9))).toBe("too-small");
  });

  it("scales its minimum area with the board", () => {
    // The pipeline's general blob minimum is tuned for tokens and would have
    // discarded most of these letters before they were ever looked at.
    expect(glyphMinArea(320, 240)).toBeLessThan(Math.round(320 * 240 * 0.0008));
    expect(glyphMinArea(320, 240)).toBeGreaterThanOrEqual(8);
    expect(glyphMinArea(192, 144)).toBeLessThan(glyphMinArea(320, 240));
  });

  it("honours overridden limits", () => {
    expect(glyphCandidate(blob(9, 11, 0.62), { ...GLYPH_LIMITS, minFill: 0.9 })).toBe("hollow");
  });

  it("scales with the board rather than assuming one size", () => {
    // The same sheet on a smaller board has proportionally smaller letters.
    expect(glyphLimits(192, 144).maxArea).toBeLessThan(glyphLimits(320, 240).maxArea);
    expect(glyphLimits(640, 480).minHeight).toBeGreaterThan(glyphLimits(320, 240).minHeight);
  });
});
