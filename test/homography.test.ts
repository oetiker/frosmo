import { describe, expect, it } from "vitest";
import {
  applyHomography,
  invertHomography,
  orderQuad,
  quadArea,
  solveHomography,
  unitQuad,
  type Quad,
} from "../src/vision/homography.js";

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("solveHomography", () => {
  it("recovers a pure scale", () => {
    const dst: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ];
    const h = solveHomography(unitQuad(), dst);
    near(applyHomography(h, 0.5, 0.5).x, 50);
    near(applyHomography(h, 0.5, 0.5).y, 40);
    near(applyHomography(h, 1, 1).x, 100);
  });

  it("maps every corner of a trapezoid exactly", () => {
    // The shape a mirror looking down at a table actually produces.
    const dst: Quad = [
      { x: 120, y: 60 },
      { x: 520, y: 55 },
      { x: 640, y: 400 },
      { x: 10, y: 410 },
    ];
    const h = solveHomography(unitQuad(), dst);
    const corners = unitQuad();
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h, corners[i].x, corners[i].y);
      near(p.x, dst[i].x, 1e-6);
      near(p.y, dst[i].y, 1e-6);
    }
  });

  it("inverts back to board space", () => {
    const dst: Quad = [
      { x: 120, y: 60 },
      { x: 520, y: 55 },
      { x: 640, y: 400 },
      { x: 10, y: 410 },
    ];
    const h = solveHomography(unitQuad(), dst);
    const inv = invertHomography(h);
    for (const [u, v] of [
      [0.25, 0.25],
      [0.5, 0.9],
      [0.83, 0.12],
    ]) {
      const cam = applyHomography(h, u, v);
      const back = applyHomography(inv, cam.x, cam.y);
      near(back.x, u, 1e-9);
      near(back.y, v, 1e-9);
    }
  });

  it("is not affine: a trapezoid compresses the far edge", () => {
    // Perspective is the whole reason for the homography. Midpoints of the
    // board must not land on midpoints of the image.
    const dst: Quad = [
      { x: 200, y: 100 },
      { x: 400, y: 100 },
      { x: 600, y: 400 },
      { x: 0, y: 400 },
    ];
    const h = solveHomography(unitQuad(), dst);
    const mid = applyHomography(h, 0.5, 0.5);
    // The narrow edge is the far one, so the far half of the board must occupy
    // fewer image rows than the near half: the board's mid-row lands well above
    // the image's mid-row, which an affine map could never do.
    expect(mid.y).toBeLessThan(220);
    expect(mid.y).toBeGreaterThan(100);
  });

  it("rejects collinear corners", () => {
    const bad: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(() => solveHomography(unitQuad(), bad)).toThrow(/degenerate/);
  });
});

describe("orderQuad", () => {
  it("puts scrambled corners into TL, TR, BR, BL", () => {
    const scrambled: Quad = [
      { x: 10, y: 90 }, // BL
      { x: 90, y: 10 }, // TR
      { x: 10, y: 10 }, // TL
      { x: 90, y: 90 }, // BR
    ];
    const q = orderQuad(scrambled);
    expect(q.map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [90, 10],
      [90, 90],
      [10, 90],
    ]);
  });

  it("leaves an already-ordered quad alone", () => {
    const q: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 1 },
      { x: 11, y: 9 },
      { x: 1, y: 10 },
    ];
    expect(orderQuad(q)).toEqual(q);
  });
});

describe("quadArea", () => {
  it("measures a unit square", () => {
    near(quadArea(unitQuad()), 1);
  });

  it("collapses to zero for a degenerate quad", () => {
    near(
      quadArea([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ]),
      0,
    );
  });
});
