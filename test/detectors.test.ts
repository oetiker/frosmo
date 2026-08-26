import { describe, expect, it } from "vitest";
import { InkDetector } from "../src/vision/ink.js";
import { countMask } from "../src/vision/mask.js";
import { chromaDistance, OccupancyDetector } from "../src/vision/occupancy.js";
import { createRectifiedFrame, type RectifiedFrame } from "../src/vision/rectify.js";

const W = 64;
const H = 48;

function frameOf(paint: (x: number, y: number) => [number, number, number]): RectifiedFrame {
  const f = createRectifiedFrame({ w: W, h: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const [r, g, b] = paint(x, y);
      f.rgba[i * 4] = r;
      f.rgba[i * 4 + 1] = g;
      f.rgba[i * 4 + 2] = b;
      f.rgba[i * 4 + 3] = 255;
      f.gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
    }
  }
  return f;
}

const emptyTable = (): RectifiedFrame => frameOf(() => [180, 175, 168]);

function withNoise(base: RectifiedFrame, amplitude: number, seed: number): RectifiedFrame {
  // Deterministic pseudo-noise so the test cannot flake.
  const f = createRectifiedFrame({ w: W, h: H });
  let s = seed;
  for (let i = 0; i < W * H; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = ((s >>> 16) % (amplitude * 2 + 1)) - amplitude;
    for (let c = 0; c < 3; c++) f.rgba[i * 4 + c] = base.rgba[i * 4 + c] + n;
    f.rgba[i * 4 + 3] = 255;
    f.gray[i] = base.gray[i] + n;
  }
  return f;
}

describe("OccupancyDetector", () => {
  it("reports nothing before a reference has been taken", () => {
    const d = new OccupancyDetector(W, H);
    expect(d.calibrated).toBe(false);
    expect(d.detect(emptyTable())).toBe(0);
  });

  it("finds a piece placed on a learned board", () => {
    const d = new OccupancyDetector(W, H);
    for (let i = 0; i < 8; i++) d.learn(emptyTable());

    const withPiece = frameOf((x, y) =>
      x >= 20 && x < 32 && y >= 16 && y < 28 ? [30, 140, 60] : [180, 175, 168],
    );
    const covered = d.detect(withPiece);
    expect(covered).toBeGreaterThan(80);
    expect(covered).toBeLessThan(200);
    expect(d.mask.data[22 * W + 25]).toBe(1);
    expect(d.mask.data[2 * W + 2]).toBe(0);
  });

  it("ignores sensor noise once the reference is averaged", () => {
    const d = new OccupancyDetector(W, H, { threshold: 26 });
    const base = emptyTable();
    for (let i = 0; i < 10; i++) d.learn(withNoise(base, 6, i + 1));
    expect(d.detect(withNoise(base, 6, 99))).toBe(0);
  });

  it("rejects a shadow but keeps the object casting it", () => {
    const d = new OccupancyDetector(W, H, { rejectShadows: true, denoise: 0, drift: 0 });
    for (let i = 0; i < 8; i++) d.learn(emptyTable());

    const scene = frameOf((x, y) => {
      // Left half: a genuinely dark object. Right half: the same surface at 55%
      // brightness, which is what a shadow does.
      if (x >= 8 && x < 20 && y >= 10 && y < 30) return [20, 20, 24];
      if (x >= 34 && x < 52 && y >= 10 && y < 34) return [99, 96, 92];
      return [180, 175, 168];
    });
    d.detect(scene);

    expect(d.mask.data[20 * W + 14]).toBe(1);
    expect(d.mask.data[20 * W + 42]).toBe(0);
  });

  it("forgets on demand", () => {
    const d = new OccupancyDetector(W, H);
    d.learn(emptyTable());
    expect(d.calibrated).toBe(true);
    d.forget();
    expect(d.calibrated).toBe(false);
  });
});

describe("chromaDistance", () => {
  it("is near zero for the same colour at different brightness", () => {
    expect(chromaDistance(200, 100, 50, 100, 50, 25)).toBeLessThan(1e-9);
  });

  it("is large for different hues at the same brightness", () => {
    expect(chromaDistance(200, 40, 40, 40, 200, 40)).toBeGreaterThan(0.2);
  });
});

describe("InkDetector", () => {
  it("finds a pen stroke on paper", () => {
    const d = new InkDetector(W, H, { radius: 6, bridge: 0 });
    const page = frameOf((x, y) => (y >= 22 && y < 25 ? [40, 40, 45] : [232, 230, 226]));
    const n = d.detect(page.gray);
    expect(n).toBeGreaterThan(100);
    expect(d.mask.data[23 * W + 30]).toBe(1);
    expect(d.mask.data[5 * W + 30]).toBe(0);
  });

  it("survives a brightness gradient across the play area", () => {
    // The mirror vignettes and the iPad lights the near edge: a global
    // threshold fails here, a local one must not.
    const d = new InkDetector(W, H, { radius: 6, bridge: 0 });
    const page = frameOf((x, y) => {
      const lit = 120 + Math.round((x / W) * 120);
      return y >= 22 && y < 25 ? [lit * 0.3, lit * 0.3, lit * 0.3] : [lit, lit, lit];
    });
    d.detect(page.gray);
    expect(d.mask.data[23 * W + 6]).toBe(1);
    expect(d.mask.data[23 * W + 58]).toBe(1);
    expect(d.mask.data[10 * W + 58]).toBe(0);
  });

  it("finds nothing on a blank page", () => {
    const d = new InkDetector(W, H, { radius: 6, bridge: 0 });
    expect(d.detect(frameOf(() => [230, 228, 224]).gray)).toBe(0);
  });

  it("bridges the gaps a dry pen leaves", () => {
    const solid = new InkDetector(W, H, { radius: 6, bridge: 1 });
    const dashed = frameOf((x, y) =>
      y >= 22 && y < 26 && x % 6 < 4 ? [40, 40, 45] : [232, 230, 226],
    );
    solid.detect(dashed.gray);
    const bare = new InkDetector(W, H, { radius: 6, bridge: 0 });
    bare.detect(dashed.gray);
    expect(countMask(solid.mask)).toBeGreaterThan(countMask(bare.mask));
  });
});
