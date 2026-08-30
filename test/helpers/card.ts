/**
 * Draw the calibration card into a grey buffer, from the same layout the
 * printer and the detector both use, so a test cannot pass against a card
 * nobody would ever print.
 */
import {
  CARD_ASPECT, CARD_WIDTH_MM, EDGE, FIDUCIALS, FIDUCIAL_INNER, FIDUCIAL_OUTER, KEY, RULES,
  SWATCHES, TILE, WEDGE,
} from "../../src/vision/card.js";
import { applyHomography, solveHomography, type Quad } from "../../src/vision/homography.js";

/**
 * A `place` that really is a camera looking at a plane.
 *
 * Narrowing the far edge by scaling x with a factor linear in y looks like
 * perspective and is not one: a plane seen by a camera foreshortens in both
 * directions at once. The difference does not show up in where the four marks
 * land — a homography can be fitted through any four points — but it shows up
 * everywhere between them, which is where all the patches are.
 *
 * @param corners the card's own four paper corners in the frame, TL TR BR BL.
 */
export function perspective(corners: Quad): (u: number, v: number) => { x: number; y: number } {
  const m = solveHomography(
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    corners,
  );
  return (u, v) => applyHomography(m, u, v);
}

export interface Drawn {
  gray: Uint8ClampedArray;
  w: number;
  h: number;
  /** Where the card's own corners landed, for checking the answer. */
  marks: Array<{ x: number; y: number }>;
}

/**
 * @param place maps card coordinates (0-1 across the card) to frame pixels,
 *              so a test can apply perspective, rotation or a mirror.
 */
export function drawCard(
  w: number,
  h: number,
  place: (u: number, v: number) => { x: number; y: number },
  opts: { ink?: number; paper?: number; blur?: number } = {},
): Drawn {
  const ink = opts.ink ?? 25;
  const paper = opts.paper ?? 240;
  const gray = new Uint8ClampedArray(w * h).fill(200); // a table, darker than paper

  // The card itself, so the marks sit on paper rather than on the table.
  fillQuad(gray, w, h, place, { x: 0, y: 0, w: 1, h: 1 }, paper);

  const short = 1 / CARD_ASPECT; // the card's short side in card-x units
  /*
   * Sampling follows the projected size, not the size on the card.
   *
   * A fixed number of samples is fine for a card filling a quarter of the
   * frame and leaves gaps in one filling most of it, at exactly the corner the
   * perspective magnifies most. A ring drawn with gaps in it comes apart in the
   * ink mask into three stripes, and then the test is measuring the rasteriser
   * rather than the finder.
   */
  const pixelsPerCardUnit = (cx: number, cy: number) => {
    const a = place(cx, cy);
    const b = place(cx + 0.01, cy);
    const c = place(cx, cy + 0.01);
    return Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y)) * 100;
  };
  const disc = (cx: number, cy: number, r: number, v: number) => {
    const steps = Math.max(24, Math.round(r * pixelsPerCardUnit(cx, cy) * 1.6));
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) {
        const du = (i / steps) * r;
        const dv = (j / steps) * r * CARD_ASPECT;
        if ((du / r) ** 2 + (dv / (r * CARD_ASPECT)) ** 2 > 1) continue;
        const p = place(cx + du, cy + dv);
        put(gray, w, h, p.x, p.y, v);
      }
    }
  };
  const ring = (cx: number, cy: number) => {
    disc(cx, cy, FIDUCIAL_OUTER * short, ink);
    disc(cx, cy, FIDUCIAL_INNER * short, paper);
  };
  for (const f of FIDUCIALS) ring(f.cx, f.cy);
  ring(KEY.cx, KEY.cy);

  for (const s of WEDGE) fillQuad(gray, w, h, place, s.patch, Math.round(paper - s.density * (paper - ink)));
  for (const s of SWATCHES) fillQuad(gray, w, h, place, s.patch, 120);
  for (const r of RULES) fillQuad(gray, w, h, place, r.patch, 150);
  fillQuad(gray, w, h, place, TILE.patch, paper);
  fillQuad(gray, w, h, place, EDGE.patch, ink);

  if (opts.blur) boxBlur(gray, w, h, opts.blur);
  return { gray, w, h, marks: FIDUCIALS.map((f) => place(f.cx, f.cy)) };
}

function put(g: Uint8ClampedArray, w: number, h: number, x: number, y: number, v: number) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi >= 0 && yi >= 0 && xi < w && yi < h) g[yi * w + xi] = v;
}

function fillQuad(
  g: Uint8ClampedArray, w: number, h: number,
  place: (u: number, v: number) => { x: number; y: number },
  p: { x: number; y: number; w: number; h: number }, v: number,
) {
  // As with the discs: enough samples for the projected size, not the printed
  // one, so a patch near the camera does not come out striped.
  const a = place(p.x, p.y);
  const b = place(p.x + p.w, p.y);
  const c = place(p.x, p.y + p.h);
  const n = Math.min(
    2000,
    Math.max(120, Math.round(Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y)) * 1.6)),
  );
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++)
      put(g, w, h, ...(({ x, y }) => [x, y] as const)(place(p.x + (p.w * i) / n, p.y + (p.h * j) / n)), v);
}

function boxBlur(g: Uint8ClampedArray, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h);
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += g[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s * norm;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      g[y * w + x] = s * norm;
    }
}

/**
 * The card squared up, in colour, the way the app sees it after rectifying —
 * with a camera that can be given a colour cast and a lens that can be blurred,
 * so a test can check the profile recovers what was put in.
 */
export function drawCardFlat(
  W: number,
  H: number,
  opts: { tint?: [number, number, number]; blur?: number; ink?: number; paper?: number } = {},
): Uint8ClampedArray {
  const tint = opts.tint ?? [1, 1, 1];
  const ink = opts.ink ?? 20;
  const paper = opts.paper ?? 248;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = paper;
    rgba[i * 4 + 3] = 255;
  }
  const box = (p: { x: number; y: number; w: number; h: number }, c: [number, number, number]) => {
    for (let y = Math.round(p.y * H); y < Math.round((p.y + p.h) * H); y++)
      for (let x = Math.round(p.x * W); x < Math.round((p.x + p.w) * W); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
  };
  for (const s of WEDGE) { const v = Math.round(paper - s.density * (paper - ink)); box(s.patch, [v, v, v]); }
  for (const s of SWATCHES) {
    const m = /^#(..)(..)(..)$/.exec(s.css)!;
    box(s.patch, [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]);
  }
  // Line pairs: bars whose width follows the printed stroke weight.
  for (const r of RULES) {
    const x0 = Math.round(r.patch.x * W), x1 = Math.round((r.patch.x + r.patch.w) * W);
    const y0 = Math.round(r.patch.y * H), y1 = Math.round((r.patch.y + r.patch.h) * H);
    const bar = Math.max(1, Math.round((r.strokeMm / CARD_WIDTH_MM) * W));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (Math.floor((x - x0) / bar) % 2) continue;
        const i = (y * W + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = ink;
      }
  }
  // Slanted edge: ink to the right of a line leaning by EDGE.degrees.
  const e = EDGE.patch;
  const slope = Math.tan((EDGE.degrees * Math.PI) / 180);
  const ex0 = Math.round(e.x * W), ex1 = Math.round((e.x + e.w) * W);
  const ey0 = Math.round(e.y * H), ey1 = Math.round((e.y + e.h) * H);
  const mid = (ex0 + ex1) / 2;
  for (let y = ey0; y < ey1; y++)
    for (let x = ex0; x < ex1; x++) {
      if (x < mid + (y - ey0) * slope) continue;
      const i = (y * W + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = ink;
    }
  if (opts.blur) blurRgba(rgba, W, H, opts.blur);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = Math.min(255, rgba[i * 4] * tint[0]);
    rgba[i * 4 + 1] = Math.min(255, rgba[i * 4 + 1] * tint[1]);
    rgba[i * 4 + 2] = Math.min(255, rgba[i * 4 + 2] * tint[2]);
  }
  return rgba;
}

function blurRgba(rgba: Uint8ClampedArray, w: number, h: number, r: number) {
  for (let ch = 0; ch < 3; ch++) {
    const tmp = new Float32Array(w * h);
    const norm = 1 / (r * 2 + 1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += rgba[(y * w + Math.min(w - 1, Math.max(0, x + k))) * 4 + ch];
        tmp[y * w + x] = s * norm;
      }
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
        rgba[(y * w + x) * 4 + ch] = s * norm;
      }
  }
}
