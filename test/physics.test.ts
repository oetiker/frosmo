import { describe, expect, it } from "vitest";
import { fieldNormal, sampleField } from "../src/engine/field.js";
import { stepBall, type Ball } from "../src/engine/physics.js";

const W = 64;
const H = 48;

/** A field with a solid horizontal bar, softened the way blurToField would. */
function barField(top: number, bottom: number) {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = y < top ? top - y : y > bottom ? y - bottom : 0;
      data[y * W + x] = Math.max(0, 1 - d / 3);
    }
  }
  return { data, w: W, h: H };
}

const emptyField = () => ({ data: new Float32Array(W * H), w: W, h: H });

const ball = (over: Partial<Ball> = {}): Ball => ({
  x: 0.5,
  y: 0.1,
  vx: 0,
  vy: 0,
  r: 0.02,
  dead: false,
  ...over,
});

describe("sampleField", () => {
  it("interpolates between pixels", () => {
    const f = emptyField();
    f.data[0] = 0;
    f.data[1] = 1;
    expect(sampleField(f, 0.5, 0)).toBeCloseTo(0.5, 6);
  });

  it("reads empty outside the board", () => {
    const f = emptyField();
    f.data.fill(1);
    expect(sampleField(f, -1, 5)).toBe(0);
    expect(sampleField(f, W + 3, 5)).toBe(0);
  });
});

describe("fieldNormal", () => {
  it("points up out of a floor", () => {
    const n = fieldNormal(barField(30, 40), 32, 30);
    expect(n.y).toBeLessThan(-0.5);
    expect(Math.abs(n.x)).toBeLessThan(0.2);
  });

  it("is zero where the field is flat", () => {
    expect(fieldNormal(emptyField(), 20, 20)).toEqual({ x: 0, y: 0 });
  });

  it("is a unit vector where it is defined", () => {
    const n = fieldNormal(barField(30, 40), 32, 31);
    expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 5);
  });
});

describe("stepBall", () => {
  const boardW = 1;
  const boardH = H / W;

  it("falls under gravity", () => {
    const b = ball();
    for (let i = 0; i < 10; i++) stepBall(b, emptyField(), boardW, boardH, 1 / 60);
    expect(b.y).toBeGreaterThan(0.1);
    expect(b.vy).toBeGreaterThan(0);
  });

  it("bounces off an obstacle instead of passing through it", () => {
    const field = barField(30, 40);
    const b = ball({ y: 0.1, vy: 0.6 });
    for (let i = 0; i < 200; i++) {
      stepBall(b, field, boardW, boardH, 1 / 60);
      if (b.vy < 0) break;
    }
    expect(b.vy).toBeLessThan(0);
    expect(b.y * W).toBeLessThan(32);
  });

  it("does not tunnel through a thin line at speed", () => {
    // The failure mode that makes mask-based collision look broken: one frame
    // above the line, next frame below it.
    const field = barField(24, 25);
    const b = ball({ y: 0.05, vy: 2.5, r: 0.015 });
    let crossed = false;
    for (let i = 0; i < 120; i++) {
      stepBall(b, field, boardW, boardH, 1 / 60);
      if (b.y * W > 30) crossed = true;
      if (crossed) break;
    }
    expect(crossed).toBe(false);
  });

  it("bounces off the side walls", () => {
    const b = ball({ x: 0.5, vx: -1.2 });
    for (let i = 0; i < 60; i++) stepBall(b, emptyField(), boardW, boardH, 1 / 60);
    expect(b.x).toBeGreaterThanOrEqual(b.r - 1e-9);
    expect(b.vx).toBeGreaterThan(0);
  });

  it("dies once it leaves the bottom of the board", () => {
    const b = ball({ y: boardH, vy: 2 });
    for (let i = 0; i < 60 && !b.dead; i++) stepBall(b, emptyField(), boardW, boardH, 1 / 60);
    expect(b.dead).toBe(true);
  });

  it("loses energy on every bounce and settles", () => {
    const field = barField(30, 40);
    const b = ball({ y: 0.1, vy: 0.5 });
    let peakSpeed = 0;
    for (let i = 0; i < 600; i++) {
      stepBall(b, field, boardW, boardH, 1 / 60);
      peakSpeed = Math.max(peakSpeed, Math.hypot(b.vx, b.vy));
    }
    expect(peakSpeed).toBeLessThan(3.01);
    expect(b.y * W).toBeLessThan(34);
  });

  it("escapes from deep inside a solid region rather than freezing", () => {
    const solid = { data: new Float32Array(W * H).fill(1), w: W, h: H };
    const b = ball({ x: 0.5, y: 0.4, vy: 0.5 });
    const before = { ...b };
    for (let i = 0; i < 30; i++) stepBall(b, solid, boardW, boardH, 1 / 60);
    expect(b.x !== before.x || b.y !== before.y).toBe(true);
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });
});
