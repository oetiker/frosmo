import { describe, expect, it } from "vitest";
import {
  boardSize,
  boardToCamera,
  defaultCalibration,
  normaliseCorners,
  orient,
  type Calibration,
} from "../src/vision/calibration.js";
import { applyHomography } from "../src/vision/homography.js";
import type { Quad } from "../src/vision/homography.js";

const corners: Quad = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("orient", () => {
  it("leaves orientation 0 alone", () => {
    expect(orient(corners, 0)).toEqual(corners);
  });

  it("rotates by quarter turns", () => {
    expect(orient(corners, 1)).toEqual([corners[1], corners[2], corners[3], corners[0]]);
    expect(orient(corners, 2)).toEqual([corners[2], corners[3], corners[0], corners[1]]);
  });

  it("mirrors for a rig that reflects the light once", () => {
    expect(orient(corners, 4)).toEqual([corners[1], corners[0], corners[3], corners[2]]);
  });

  it("returns to the original after four rotations", () => {
    expect(orient(corners, 0)).toEqual(orient(orient(orient(orient(corners, 1), 1), 1), 1));
  });
});

describe("boardToCamera", () => {
  const cal: Calibration = {
    ...defaultCalibration(),
    corners: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    orientation: 0,
  };

  it("scales normalised corners to the capture resolution", () => {
    const h = boardToCamera(cal, 640, 480);
    const p = applyHomography(h, 1, 1);
    expect(p.x).toBeCloseTo(640, 6);
    expect(p.y).toBeCloseTo(480, 6);
  });

  it("stays valid when the capture resolution changes", () => {
    // The reason corners are stored normalised: iPadOS may hand back a
    // different capture size after a backgrounding, and that must not
    // invalidate a calibration the user did once.
    const a = applyHomography(boardToCamera(cal, 640, 480), 0.5, 0.25);
    const b = applyHomography(boardToCamera(cal, 1280, 960), 0.5, 0.25);
    expect(b.x / a.x).toBeCloseTo(2, 6);
    expect(b.y / a.y).toBeCloseTo(2, 6);
  });

  it("mirrors the board when the orientation says so", () => {
    const plain = applyHomography(boardToCamera(cal, 100, 100), 0.1, 0.5);
    const flipped = applyHomography(boardToCamera({ ...cal, orientation: 4 }, 100, 100), 0.1, 0.5);
    expect(plain.x).toBeCloseTo(10, 6);
    expect(flipped.x).toBeCloseTo(90, 6);
  });
});

describe("boardSize", () => {
  it("derives height from the play area's aspect", () => {
    expect(boardSize({ ...defaultCalibration(), resolution: 256, aspect: 4 / 3 })).toEqual({
      w: 256,
      h: 192,
    });
    expect(boardSize({ ...defaultCalibration(), resolution: 320, aspect: 1.5 })).toEqual({
      w: 320,
      h: 213,
    });
  });

  it("clamps absurd resolutions", () => {
    expect(boardSize({ ...defaultCalibration(), resolution: 4 }).w).toBe(64);
  });
});

describe("normaliseCorners", () => {
  it("normalises, orders and accepts a real drag", () => {
    const dragged: Quad = [
      { x: 100, y: 400 },
      { x: 500, y: 60 },
      { x: 100, y: 60 },
      { x: 500, y: 400 },
    ];
    const q = normaliseCorners(dragged, 640, 480);
    expect(q).not.toBeNull();
    expect(q![0]).toEqual({ x: 100 / 640, y: 60 / 480 });
    expect(q![2]).toEqual({ x: 500 / 640, y: 400 / 480 });
  });

  it("rejects a mis-drag that collapses the play area", () => {
    const tiny: Quad = [
      { x: 100, y: 100 },
      { x: 108, y: 100 },
      { x: 108, y: 108 },
      { x: 100, y: 108 },
    ];
    expect(normaliseCorners(tiny, 640, 480)).toBeNull();
  });

  it("clamps corners dragged off the edge of the frame", () => {
    const off: Quad = [
      { x: -50, y: -20 },
      { x: 900, y: -20 },
      { x: 900, y: 700 },
      { x: -50, y: 700 },
    ];
    const q = normaliseCorners(off, 640, 480)!;
    for (const p of q) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });
});
