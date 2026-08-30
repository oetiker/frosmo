/**
 * Finding the tiles rather than the ink on them.
 *
 * The synthetic cases fix the mechanics; the last one is the real thing — the
 * ink mask the app produced from a capture of the printed sheet, uncut, with
 * neighbouring frames almost touching. That is the hardest arrangement the
 * finder meets, and the one that decides whether the idea is worth having.
 */
import { describe, expect, it } from "vitest";
import { createMask, type Mask } from "../src/vision/mask.js";
import { TileFinder } from "../src/vision/tile-finder.js";
import fixture from "./fixtures/rig-ink-mask.json";

const W = 256;
const H = 192;

/** A tile: a thin frame with a letter-sized mark loose inside it. */
function tile(m: Mask, x: number, y: number, size: number, gap = 0): void {
  const put = (px: number, py: number) => {
    if (px >= 0 && py >= 0 && px < m.w && py < m.h) m.data[py * m.w + px] = 1;
  };
  for (let i = 0; i < size; i++) {
    // `gap` leaves the frame broken, the way a threshold leaves a printed one.
    if (i > size / 2 && i < size / 2 + gap) continue;
    put(x + i, y);
    put(x + i, y + size - 1);
    put(x, y + i);
    put(x + size - 1, y + i);
  }
  // A letter-sized mark: about a third of the tile, well clear of the frame.
  const mx = Math.round(x + size * 0.4);
  const my = Math.round(y + size * 0.32);
  for (let dy = 0; dy < Math.round(size * 0.36); dy++)
    for (let dx = 0; dx < Math.round(size * 0.2); dx++) put(mx + dx, my + dy);
}

function sheet(cols: number, rows: number, size = 28, pitch = 33, gap = 0): Mask {
  const m = createMask(W, H);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tile(m, 6 + c * pitch, 6 + r * pitch, size, gap);
  return m;
}

describe("TileFinder", () => {
  it("finds every tile of a clean sheet", () => {
    const found = new TileFinder(W, H).find(sheet(6, 4));
    expect(found).toHaveLength(24);
  });

  it("finds them through the gaps a threshold leaves in a printed frame", () => {
    // The reason the mask is dilated first. Without sealing, the interior is
    // not enclosed and leaks into its neighbours, and nothing is found at all.
    const found = new TileFinder(W, H).find(sheet(6, 4, 28, 33, 3));
    expect(found.length).toBeGreaterThanOrEqual(20);
  });

  it("reports the box, not the ink inside it", () => {
    // The glyph drags the hole's centroid towards whichever side it is heavier
    // on; cropping from that centre walks the crop onto the frame.
    const m = createMask(W, H);
    tile(m, 40, 40, 28);
    const [t] = new TileFinder(W, H).find(m);
    // The tile spans 40..67, so its centre is 53.5 whatever the ink does.
    expect(t.cx).toBeCloseTo(53.5, 1);
    expect(t.cy).toBeCloseTo(53.5, 1);
    expect(t.w).toBeGreaterThan(20);
    expect(t.h).toBeGreaterThan(20);
  });

  it("ignores the table around the sheet", () => {
    const found = new TileFinder(W, H).find(sheet(2, 2));
    expect(found).toHaveLength(4);
  });

  it("finds nothing in a mask with no frames in it", () => {
    // Osmo's own tiles and Scrabble have no printed frame; the pipeline falls
    // back to ink blobs when this comes back empty.
    const m = createMask(W, H);
    for (let y = 40; y < 50; y++) for (let x = 40; x < 48; x++) m.data[y * W + x] = 1;
    expect(new TileFinder(W, H).find(m)).toHaveLength(0);
  });

  it("finds the tiles on the sheet the rig photographed", () => {
    const m = createMask(fixture.w, fixture.h);
    for (let i = 0; i < fixture.bits.length; i++) {
      const v = parseInt(fixture.bits[i], 16);
      m.data[i * 4] = (v >> 3) & 1;
      m.data[i * 4 + 1] = (v >> 2) & 1;
      m.data[i * 4 + 2] = (v >> 1) & 1;
      m.data[i * 4 + 3] = v & 1;
    }
    const found = new TileFinder(fixture.w, fixture.h).find(m);
    // 33 of the sheet's 36, uncut, with the frames almost touching.
    expect(found.length).toBeGreaterThanOrEqual(32);
    expect(found.length).toBeLessThanOrEqual(fixture.tiles);
  });
});
