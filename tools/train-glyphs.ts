/**
 * Train the glyph recogniser.
 *
 *   node tools/render-glyphs.mjs        # once, needs a browser
 *   npx vite-node tools/train-glyphs.ts
 *
 * Template matching counts overlapping pixels, which is why it could never
 * separate D from O: they overlap almost everywhere, and differ in one straight
 * edge a few pixels wide. A trained classifier can weight that edge. Nothing
 * here is exotic — one hidden layer, plain gradient descent — because the
 * problem is not hard once the input is right. What makes it work is the
 * training data.
 *
 * The model is a small convolutional net rather than a flat one. A flat layer
 * sees 576 independent pixels and has to learn every letter at every position
 * and thickness separately; on this data it plateaus around 90% on letters,
 * with D mistaken for O, U for M and R for B — all pairs that differ in one
 * local feature, a straight edge or a junction, which is precisely what a
 * convolution is for. This net has about 22,000 parameters against the flat
 * one's 57,000, and does better.
 *
 * Two things about the training data matter more than either:
 *
 *   - It is degraded the way a tablet camera degrades a printed tile: blurred,
 *     noisy, dimmed, thickened, rotated a little, seen at a range of sizes, and
 *     sometimes with the tile's own printed border intruding into the crop.
 *     Trained on clean renders, a model learns a problem nobody has.
 *   - It passes through the app's own normaliseGlyph, imported rather than
 *     reimplemented. Train on one preprocessing and infer with another and the
 *     model is reading a different alphabet from the one it learned.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { GLYPH_SIZE, normaliseGlyph } from "../src/vision/glyph.js";

const BASE = JSON.parse(readFileSync(".glyphs/base.json", "utf8")) as {
  size: number;
  chars: string;
  glyphs: Record<string, number[]>;
};

const CHARS = [...BASE.chars];
/**
 * One class beyond the alphabet: "this is not a character".
 *
 * Without it the net is forced to name every crop it is handed, and it does so
 * confidently — a fragment of a tile's printed border reads as L at 1.00, the
 * rim of a colour token reads as O. Nothing downstream can undo that, because
 * the confidence is real: among 36 letters, a vertical bar genuinely is most
 * like an L. The answer is to let it say none of them.
 *
 * The reject class is exempt from the alphabet restriction at inference — a
 * game narrowing the answer to letters must not thereby lose the option of
 * refusing.
 */
const REJECT = CHARS.length;
const CLASSES = CHARS.length + 1;
const INPUT = GLYPH_SIZE * GLYPH_SIZE;
/** Matches the crop the tile detector takes: glyph plus surroundings. */
const CROP = GLYPH_SIZE * 2;
/** Feature maps per convolution. Small on purpose — see the note below. */
const C1 = 12;
const C2 = 28;
const POOLED = 6 * 6 * C2;

// ---------------------------------------------------------------- rng

/** Deterministic, so a rebuild of the model is reproducible. */
let seed = 12345;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const gauss = () => {
  const u = Math.max(1e-9, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};

// ---------------------------------------------------------------- sampling

/**
 * One synthetic observation: a glyph as the camera might have delivered it.
 *
 * The transform is applied by inverse mapping from the crop back into the
 * source, which keeps it a single resampling step rather than a chain of them
 * — each of which would blur the result more than the camera does.
 */
function sample(ch: string): Uint8Array {
  const src = BASE.glyphs[ch];
  const n = BASE.size;
  const crop = new Uint8ClampedArray(CROP * CROP);

  const angle = between(-0.18, 0.18);
  const shear = between(-0.1, 0.1);
  // How much of the crop the glyph fills: a tile far from the camera is small
  // in frame, one close to it nearly fills the crop.
  const fill = between(0.42, 0.92);
  const scale = n / (CROP * fill);
  const offX = between(-0.08, 0.08) * CROP;
  const offY = between(-0.08, 0.08) * CROP;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const blur = between(0, 1.7);
  const contrast = between(0.55, 1.25);
  const bright = between(-35, 25);
  const noise = between(0, 16);
  // Ink spreads on paper and thickens under a soft lens; occasionally it thins.
  const weight = between(-0.9, 1.6);

  for (let y = 0; y < CROP; y++) {
    for (let x = 0; x < CROP; x++) {
      const cx = x - CROP / 2 - offX;
      const cy = y - CROP / 2 - offY;
      const rx = cx * cos - cy * sin + shear * cy;
      const ry = cx * sin + cy * cos;
      const sx = rx * scale + n / 2;
      const sy = ry * scale + n / 2;

      let v = bilinear(src, n, sx, sy);
      if (weight !== 0) v = v + weight * (v - bilinear(src, n, sx + 0.8, sy + 0.8));
      v = (v - 128) * contrast + 128 + bright + gauss() * noise;
      crop[y * CROP + x] = v;
    }
  }

  if (blur > 0.2) boxBlur(crop, CROP, Math.round(blur));

  // A fifth of the time, part of the tile's printed border cuts into the crop.
  // It happens constantly in practice and a model that has never seen it reads
  // the border as part of the letter.
  if (rnd() < 0.2) {
    const edge = Math.floor(rnd() * 4);
    const depth = Math.round(between(1, 4));
    const dark = between(20, 90);
    for (let i = 0; i < CROP; i++) {
      for (let d = 0; d < depth; d++) {
        const p =
          edge === 0 ? d * CROP + i :
          edge === 1 ? (CROP - 1 - d) * CROP + i :
          edge === 2 ? i * CROP + d :
          i * CROP + (CROP - 1 - d);
        crop[p] = dark;
      }
    }
  }

  // The app's own preprocessing, imported: train on exactly what inference sees.
  return normaliseGlyph(crop, CROP, CROP);
}

/**
 * One synthetic observation of something that is not a character.
 *
 * These are drawn from what the blob finder actually hands over on a real
 * sheet, read off a capture from the rig: segments of the tiles' printed
 * borders, the corners where two of them meet, whole rounded frames, the rims
 * and bodies of colour tokens, and blank paper. Every one of those passes a
 * shape filter — they are glyph-sized and glyph-shaped — so the filter cannot
 * be what rejects them. The net has to.
 */
function negative(): Uint8Array {
  const crop = new Uint8ClampedArray(CROP * CROP);
  const paper = between(200, 250);
  crop.fill(paper);
  const ink = between(10, 90);

  /** Distance from (x,y) to the segment (x0,y0)-(x1,y1). */
  const distToSeg = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => {
    const dx = x1 - x0, dy = y1 - y0;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len)) : 0;
    const px = x0 + t * dx - x, py = y0 + t * dy - y;
    return Math.sqrt(px * px + py * py);
  };

  /** A stroke crossing the whole crop at `a` radians, `off` to one side of centre. */
  const bar = (a: number, thick: number, off: number) => {
    const c = CROP / 2 + Math.cos(a + Math.PI / 2) * off;
    const d = CROP / 2 + Math.sin(a + Math.PI / 2) * off;
    const dx = Math.cos(a) * CROP, dy = Math.sin(a) * CROP;
    return (x: number, y: number) => distToSeg(x, y, c - dx, d - dy, c + dx, d + dy) < thick;
  };

  /**
   * An angle away from vertical — for the single-bar cases only.
   *
   * A lone upright stroke is an I, and no amount of training separates one from
   * an upright piece of tile border: they are the same picture. Teaching the
   * net to refuse it would cost every real I on the sheet, so the single bar is
   * drawn slanted or flat, where no letterform competes for it.
   */
  const slanted = () => {
    const a = between(0.5, Math.PI - 0.5);
    return Math.abs(a - Math.PI / 2) < 0.5 ? (a < Math.PI / 2 ? a - 1 : a + 1) : a;
  };

  /*
   * The families are not drawn equally often, and the weighting is the whole
   * game. Four of them — a bar, a corner, a frame, an arc — are shapes that
   * letters also make: I, L, O, C. Every sample of those teaches the net to
   * refuse something, and some of what it learns to refuse is a letter. The
   * first model trained this way lost J, T, I, G, O, U, D and L to the reject
   * class, in that order, which is exactly that list. A fourth family, two
   * crossing strokes, is gone entirely: it draws an X. The corners it was there
   * for are already in the frames.
   *
   * The other four — blank paper, a filled disc, a pair of parallel strokes,
   * speckle — are not any letter at all, and cost nothing to learn. They are
   * also, on a real sheet, most of what actually turns up. So the safe families
   * carry the weight and the letter-shaped ones are drawn sparingly: enough to
   * be recognised, not enough to take a letterform with them.
   */
  const kind = [0, 0, 1, 3, 3, 4, 4, 5, 6, 6, 6, 6, 6, 8, 8, 8][Math.floor(rnd() * 16)];
  let inside: (x: number, y: number) => boolean;

  if (kind === 0) {
    // Blank paper. The tile reader guards on ink density too, but a model that
    // has never seen emptiness will not be the one to catch what slips past.
    inside = () => false;
  } else if (kind === 1) {
    inside = bar(slanted(), between(1, 3.4), between(-0.3, 0.3) * CROP);
  } else if (kind === 6) {
    // Two near-parallel strokes with a gap between them: the facing edges of
    // two tiles sitting side by side. On the app's own printout this is by some
    // way the commonest thing the blob finder hands over — and unlike a single
    // upright stroke it is not any letter, so it can be refused outright.
    const a = between(0, Math.PI);
    const gap = between(0.12, 0.45) * CROP;
    const thick = between(1, 3);
    const centre = between(-0.12, 0.12) * CROP;
    const one = bar(a, thick, centre - gap / 2);
    const two = bar(a + between(-0.09, 0.09), thick, centre + gap / 2);
    inside = (x, y) => one(x, y) || two(x, y);
  } else if (kind === 3) {
    // A rounded rectangle, drawn as an outline and usually running off the
    // crop: the tiles on the app's own printout are exactly this. A crop that
    // catches only one corner of it is an L, which is a real letter — the two
    // are told apart by weight, so every structural line here is drawn thinner
    // than a glyph stroke at the same scale ever gets. That is true of the
    // printout as well: the borders are hairlines and the letters are bold.
    const w = between(0.5, 1.4) * CROP, h = between(0.5, 1.4) * CROP;
    const cx = CROP / 2 + between(-0.3, 0.3) * CROP;
    const cy = CROP / 2 + between(-0.3, 0.3) * CROP;
    const thick = between(1, 2.8);
    inside = (x, y) => {
      const dx = Math.abs(x - cx) - w / 2, dy = Math.abs(y - cy) - h / 2;
      const d = Math.max(dx, dy);
      return d > -thick && d < thick;
    };
  } else if (kind === 4) {
    // A filled ellipse: a colour token, or a thumb.
    const cx = CROP / 2 + between(-0.25, 0.25) * CROP;
    const cy = CROP / 2 + between(-0.25, 0.25) * CROP;
    const rx = between(0.25, 0.7) * CROP, ry = between(0.25, 0.7) * CROP;
    inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
  } else if (kind === 5) {
    // The rim of one, and only ever a piece of it. A whole ring is an O and a
    // three-quarter one is a C or a G, so the span is kept under a half turn
    // and the radius large: what is left is a shallow curve, which no letter is.
    const a0 = between(0, Math.PI * 2);
    const span = between(0.5, 1.5);
    const r = between(0.55, 1.3) * CROP;
    const cx = CROP / 2 - Math.cos(a0 + span / 2) * r;
    const cy = CROP / 2 - Math.sin(a0 + span / 2) * r;
    const thick = between(1.5, 4);
    inside = (x, y) => {
      if (Math.abs(Math.hypot(x - cx, y - cy) - r) >= thick) return false;
      let d = Math.atan2(y - cy, x - cx) - a0;
      while (d < 0) d += Math.PI * 2;
      return d <= span;
    };
  } else {
    // Speckle: dust, print noise, a shadow edge broken into pieces.
    const spots: [number, number, number][] = [];
    for (let i = 0, n = 3 + Math.floor(rnd() * 8); i < n; i++)
      spots.push([rnd() * CROP, rnd() * CROP, between(1.5, 5)]);
    inside = (x, y) => spots.some(([sx, sy, r]) => Math.hypot(x - sx, y - sy) < r);
  }

  for (let y = 0; y < CROP; y++)
    for (let x = 0; x < CROP; x++)
      if (inside(x, y)) crop[y * CROP + x] = ink;

  // Same camera as the characters get, so the net cannot separate the classes
  // on image quality instead of on shape.
  const blur = between(0, 1.7);
  const contrast = between(0.55, 1.25);
  const bright = between(-35, 25);
  const noise = between(0, 16);
  for (let i = 0; i < CROP * CROP; i++)
    crop[i] = (crop[i] - 128) * contrast + 128 + bright + gauss() * noise;
  if (blur > 0.2) boxBlur(crop, CROP, Math.round(blur));

  return normaliseGlyph(crop, CROP, CROP);
}

function bilinear(src: number[], n: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > n - 1 || y > n - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, n - 1);
  const y1 = Math.min(y0 + 1, n - 1);
  const fx = x - x0;
  const fy = y - y0;
  return (
    src[y0 * n + x0] * (1 - fx) * (1 - fy) +
    src[y0 * n + x1] * fx * (1 - fy) +
    src[y1 * n + x0] * (1 - fx) * fy +
    src[y1 * n + x1] * fx * fy
  );
}

function boxBlur(buf: Uint8ClampedArray, n: number, r: number): void {
  if (r < 1) return;
  const tmp = new Float32Array(n * n);
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += buf[y * n + Math.min(n - 1, Math.max(0, x + k))];
      tmp[y * n + x] = s * norm;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(n - 1, Math.max(0, y + k)) * n + x];
      buf[y * n + x] = s * norm;
    }
  }
}

/**
 * Reject covers seven shape families against one letterform each, so it gets a
 * proportionally larger share — at parity it is the thinnest-sampled class in
 * the set and the net under-fits exactly the thing it is there to catch.
 */
const REJECT_SHARE = 4;

function buildSet(perClass: number): { x: Uint8Array; y: Int32Array } {
  const rejects = perClass * REJECT_SHARE;
  const count = perClass * CHARS.length + rejects;
  const x = new Uint8Array(count * INPUT);
  const y = new Int32Array(count);
  let i = 0;
  for (let c = 0; c < CHARS.length; c++) {
    for (let k = 0; k < perClass; k++) {
      x.set(sample(CHARS[c]), i * INPUT);
      y[i] = c;
      i++;
    }
  }
  for (let k = 0; k < rejects; k++) {
    x.set(negative(), i * INPUT);
    y[i] = REJECT;
    i++;
  }
  return { x, y };
}

// ---------------------------------------------------------------- model

/*
 * 24x24 -> conv 3x3 x8 -> relu -> maxpool 2 -> conv 3x3 x16 -> relu
 *       -> maxpool 2 -> 6x6x16 flattened -> 36 logits
 *
 * Written out by hand rather than pulled from a framework: the forward pass has
 * to ship to the browser anyway, and a few hundred lines of plain loops is a
 * smaller commitment than a dependency that would dwarf the whole app.
 */

const S = GLYPH_SIZE; // 24
const S2 = S / 2; // 12
const S4 = S / 4; // 6

const k1 = new Float32Array(C1 * 9);
const kb1 = new Float32Array(C1);
const k2 = new Float32Array(C2 * C1 * 9);
const kb2 = new Float32Array(C2);
const fw = new Float32Array(POOLED * CLASSES);
const fb = new Float32Array(CLASSES);

for (let i = 0; i < k1.length; i++) k1[i] = gauss() * Math.sqrt(2 / 9);
for (let i = 0; i < k2.length; i++) k2[i] = gauss() * Math.sqrt(2 / (9 * C1));
for (let i = 0; i < fw.length; i++) fw[i] = gauss() * Math.sqrt(1 / POOLED);

const params = [k1, kb1, k2, kb2, fw, fb];
const grads = params.map((p) => new Float32Array(p.length));
const vels = params.map((p) => new Float32Array(p.length));
const [gk1, gkb1, gk2, gkb2, gfw, gfb] = grads;

// Activations, allocated once.
const a0 = new Float32Array(S * S);
const z1 = new Float32Array(C1 * S * S);
const p1 = new Float32Array(C1 * S2 * S2);
const p1arg = new Int32Array(C1 * S2 * S2);
const z2 = new Float32Array(C2 * S2 * S2);
const p2 = new Float32Array(C2 * S4 * S4);
const p2arg = new Int32Array(C2 * S4 * S4);
const logits = new Float32Array(CLASSES);
const probs = new Float32Array(CLASSES);

const dz1 = new Float32Array(z1.length);
const dp1 = new Float32Array(p1.length);
const dz2 = new Float32Array(z2.length);
const dp2 = new Float32Array(p2.length);

/** Valid-padded-by-one convolution: output is the same size as the input. */
function conv(
  input: Float32Array, inC: number, size: number,
  kernel: Float32Array, bias: Float32Array, outC: number,
  out: Float32Array,
): void {
  for (let oc = 0; oc < outC; oc++) {
    const ob = oc * size * size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = bias[oc];
        for (let ic = 0; ic < inC; ic++) {
          const ib = ic * size * size;
          const kb = (oc * inC + ic) * 9;
          for (let ky = -1; ky <= 1; ky++) {
            const sy = y + ky;
            if (sy < 0 || sy >= size) continue;
            for (let kx = -1; kx <= 1; kx++) {
              const sx = x + kx;
              if (sx < 0 || sx >= size) continue;
              s += input[ib + sy * size + sx] * kernel[kb + (ky + 1) * 3 + (kx + 1)];
            }
          }
        }
        out[ob + y * size + x] = s > 0 ? s : 0;
      }
    }
  }
}

/** 2x2 max pool, remembering which input won so the gradient can be routed back. */
function pool(input: Float32Array, ch: number, size: number, out: Float32Array, arg: Int32Array): void {
  const half = size / 2;
  for (let c = 0; c < ch; c++) {
    const ib = c * size * size;
    const ob = c * half * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        let best = -Infinity;
        let bestAt = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const at = ib + (y * 2 + dy) * size + (x * 2 + dx);
            if (input[at] > best) {
              best = input[at];
              bestAt = at;
            }
          }
        }
        out[ob + y * half + x] = best;
        arg[ob + y * half + x] = bestAt;
      }
    }
  }
}

function forward(x: Uint8Array, at: number): void {
  for (let i = 0; i < S * S; i++) a0[i] = x[at + i];
  conv(a0, 1, S, k1, kb1, C1, z1);
  pool(z1, C1, S, p1, p1arg);
  conv(p1, C1, S2, k2, kb2, C2, z2);
  pool(z2, C2, S2, p2, p2arg);

  let max = -Infinity;
  for (let c = 0; c < CLASSES; c++) {
    let s = fb[c];
    const row = c * POOLED;
    for (let i = 0; i < POOLED; i++) s += fw[row + i] * p2[i];
    logits[c] = s;
    if (s > max) max = s;
  }
  let sum = 0;
  for (let c = 0; c < CLASSES; c++) {
    probs[c] = Math.exp(logits[c] - max);
    sum += probs[c];
  }
  for (let c = 0; c < CLASSES; c++) probs[c] /= sum;
}

/** Gradient of a convolution with respect to its kernel and its input. */
function convBackward(
  input: Float32Array, inC: number, size: number,
  kernel: Float32Array, outC: number,
  z: Float32Array, dOut: Float32Array,
  dKernel: Float32Array, dBias: Float32Array, dInput: Float32Array | null,
): void {
  if (dInput) dInput.fill(0);
  for (let oc = 0; oc < outC; oc++) {
    const ob = oc * size * size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = ob + y * size + x;
        if (z[at] <= 0) continue; // relu
        const d = dOut[at];
        if (d === 0) continue;
        dBias[oc] += d;
        for (let ic = 0; ic < inC; ic++) {
          const ib = ic * size * size;
          const kb = (oc * inC + ic) * 9;
          for (let ky = -1; ky <= 1; ky++) {
            const sy = y + ky;
            if (sy < 0 || sy >= size) continue;
            for (let kx = -1; kx <= 1; kx++) {
              const sx = x + kx;
              if (sx < 0 || sx >= size) continue;
              const ki = kb + (ky + 1) * 3 + (kx + 1);
              dKernel[ki] += d * input[ib + sy * size + sx];
              if (dInput) dInput[ib + sy * size + sx] += d * kernel[ki];
            }
          }
        }
      }
    }
  }
}

function backward(label: number): number {
  const loss = -Math.log(Math.max(1e-9, probs[label]));

  dp2.fill(0);
  for (let c = 0; c < CLASSES; c++) {
    const d = probs[c] - (c === label ? 1 : 0);
    const row = c * POOLED;
    gfb[c] += d;
    for (let i = 0; i < POOLED; i++) {
      gfw[row + i] += d * p2[i];
      dp2[i] += d * fw[row + i];
    }
  }

  dz2.fill(0);
  for (let i = 0; i < p2.length; i++) dz2[p2arg[i]] += dp2[i];
  convBackward(p1, C1, S2, k2, C2, z2, dz2, gk2, gkb2, dp1);

  dz1.fill(0);
  for (let i = 0; i < p1.length; i++) dz1[p1arg[i]] += dp1[i];
  convBackward(a0, 1, S, k1, C1, z1, dz1, gk1, gkb1, null);

  return loss;
}

function zeroGrads(): void {
  for (const g of grads) g.fill(0);
}

function applyGrads(lr: number, batch: number, momentum: number): void {
  for (let p = 0; p < params.length; p++) {
    const w = params[p];
    const g = grads[p];
    const v = vels[p];
    for (let i = 0; i < w.length; i++) {
      v[i] = momentum * v[i] - (lr / batch) * g[i];
      w[i] += v[i];
    }
  }
}

/**
 * Check the analytic gradients against numeric ones.
 *
 * Hand-written backpropagation fails silently — the loss still falls, just to
 * the wrong place, and an earlier version of this trainer diverged from exactly
 * such a mistake. A few finite differences settle it.
 *
 * The statistic is the median relative error, not the worst. ReLU and max
 * pooling are not differentiable everywhere, and with binary inputs exact ties
 * are common: nudge a weight across one and the finite difference measures a
 * kink the analytic gradient cannot see. Those disagreements are real but
 * meaningless, they affect a minority of coordinates, and taking the worst case
 * makes the check fail on correct code. The median ignores them; a genuine
 * error in the chain rule moves every coordinate at once.
 */
function gradientCheck(x: Uint8Array, label: number): { median: number; worst: number } {
  zeroGrads();
  forward(x, 0);
  backward(label);

  const errors: number[] = [];
  for (const [w, g] of [[k1, gk1], [k2, gk2], [fw, gfw], [kb1, gkb1], [fb, gfb]] as const) {
    for (let t = 0; t < 16; t++) {
      const i = Math.floor(rnd() * w.length);
      const eps = 1e-4;
      const original = w[i];

      w[i] = original + eps;
      forward(x, 0);
      const up = -Math.log(Math.max(1e-12, probs[label]));
      w[i] = original - eps;
      forward(x, 0);
      const down = -Math.log(Math.max(1e-12, probs[label]));
      w[i] = original;

      const numeric = (up - down) / (2 * eps);
      const scale = Math.max(1e-5, Math.abs(numeric) + Math.abs(g[i]));
      errors.push(Math.abs(numeric - g[i]) / scale);
    }
  }

  errors.sort((a, b) => a - b);
  return { median: errors[errors.length >> 1], worst: errors[errors.length - 1] };
}

/**
 * Accuracy, optionally restricted to the characters a game actually uses.
 *
 * The unrestricted number is the pessimistic one and not what any game sees:
 * Spell It never offers a digit, so a letter losing to one is a confusion that
 * cannot happen in play. Restricting the argmax to the alphabet in use is
 * exactly what the app does at inference, so it is what should be measured.
 */
function accuracy(
  set: { x: Uint8Array; y: Int32Array },
  allowed?: string,
): { acc: number; worst: Array<[string, string, number]> } {
  // Reject is always allowed: a game that narrows the answer to letters is
  // saying which letters it might see, not promising that it will see one.
  const mask = CHARS.map((c) => !allowed || allowed.includes(c));
  mask[REJECT] = true;
  const name = (c: number) => (c === REJECT ? "·" : CHARS[c]);
  const confusion = new Map<string, number>();
  let right = 0;
  let counted = 0;
  for (let i = 0; i < set.y.length; i++) {
    if (!mask[set.y[i]] || (allowed && set.y[i] === REJECT)) continue;
    counted++;
    forward(set.x, i * INPUT);
    let best = -1;
    for (let c = 0; c < CLASSES; c++) if (mask[c] && (best < 0 || probs[c] > probs[best])) best = c;
    if (best === set.y[i]) right++;
    else {
      const key = `${name(set.y[i])}>${name(best)}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
  }
  const worst = [...confusion.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, n]) => [k.split(">")[0], k.split(">")[1], n] as [string, string, number]);
  return { acc: counted ? right / counted : 0, worst };
}

// ---------------------------------------------------------------- run

console.log(`building training data (${CLASSES} classes)…`);
const train = buildSet(1000);
const val = buildSet(150);
console.log(`train ${train.y.length}   validation ${val.y.length}`);

const check = gradientCheck(train.x.slice(0, INPUT), train.y[0]);
console.log(
  `gradient check: median relative error ${check.median.toExponential(2)}` +
    `  (worst ${check.worst.toExponential(2)}, kinks expected)`,
);
if (!(check.median < 0.02)) {
  console.error("backpropagation disagrees with finite differences — refusing to train");
  process.exit(1);
}
console.log("");

const EPOCHS = 22;
const BATCH = 16;
const order = new Int32Array(train.y.length);
for (let i = 0; i < order.length; i++) order[i] = i;

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lr = 0.09 * Math.pow(0.87, epoch);
  let loss = 0;
  zeroGrads();
  for (let k = 0; k < order.length; k++) {
    forward(train.x, order[k] * INPUT);
    loss += backward(train.y[order[k]]);
    if ((k + 1) % BATCH === 0) {
      applyGrads(lr, BATCH, 0.9);
      zeroGrads();
    }
  }
  if (!Number.isFinite(loss)) {
    console.error("training diverged — lower the learning rate");
    process.exit(1);
  }
  const { acc } = accuracy(val, "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  console.log(
    `epoch ${String(epoch + 1).padStart(2)}  lr ${lr.toFixed(4)}  loss ${(loss / order.length).toFixed(4)}  letters ${(acc * 100).toFixed(2)}%`,
  );
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const all = accuracy(val);
const letters = accuracy(val, LETTERS);
const digits = accuracy(val, DIGITS);

console.log(`\nvalidation accuracy`);
console.log(`  all 36 characters   ${(all.acc * 100).toFixed(2)}%`);
console.log(`  letters only        ${(letters.acc * 100).toFixed(2)}%   ← what Spell It sees`);
console.log(`  digits only         ${(digits.acc * 100).toFixed(2)}%`);
console.log("\nworst confusions, letters:", letters.worst.map(([a, b, n]) => `${a}→${b} ×${n}`).join("  ") || "none");

/**
 * The two numbers the accuracy table hides, measured under play conditions —
 * letters allowed, reject allowed. Catching junk is only half of it: a model
 * that rejects everything scores perfectly on the first number and is useless.
 */
function rejection(set: { x: Uint8Array; y: Int32Array }): { caught: number; falsely: number } {
  const mask = CHARS.map((c) => LETTERS.includes(c));
  mask[REJECT] = true;
  let junk = 0, junkCaught = 0, real = 0, realRejected = 0;
  for (let i = 0; i < set.y.length; i++) {
    const truth = set.y[i];
    if (truth !== REJECT && !mask[truth]) continue;
    forward(set.x, i * INPUT);
    let best = -1;
    for (let c = 0; c < CLASSES; c++) if (mask[c] && (best < 0 || probs[c] > probs[best])) best = c;
    if (truth === REJECT) { junk++; if (best === REJECT) junkCaught++; }
    else { real++; if (best === REJECT) realRejected++; }
  }
  return { caught: junk ? junkCaught / junk : 0, falsely: real ? realRejected / real : 0 };
}

const rej = rejection(val);
console.log(`\nreject class`);
console.log(`  junk refused        ${(rej.caught * 100).toFixed(2)}%   ← borders, token rims, blank paper`);
console.log(`  letters refused     ${(rej.falsely * 100).toFixed(2)}%   ← the cost of it`);

// ---------------------------------------------------------------- save

/** Quantise to int8 with one scale per tensor: a quarter of the size, no measurable loss. */
function quantise(w: Float32Array): { scale: number; data: number[] } {
  let max = 0;
  for (const v of w) max = Math.max(max, Math.abs(v));
  const scale = max / 127 || 1;
  return { scale, data: Array.from(w, (v) => Math.round(v / scale)) };
}

const model = {
  version: 3,
  kind: "cnn",
  chars: BASE.chars,
  /** The FC layer has one row past `chars`: "none of these". See glyph-net.ts. */
  reject: true,
  input: GLYPH_SIZE,
  c1: C1,
  c2: C2,
  accuracy: {
    all: Number(all.acc.toFixed(4)),
    letters: Number(letters.acc.toFixed(4)),
    digits: Number(digits.acc.toFixed(4)),
    junkRefused: Number(rej.caught.toFixed(4)),
    lettersRefused: Number(rej.falsely.toFixed(4)),
  },
  k1: quantise(k1),
  kb1: Array.from(kb1, (v) => Number(v.toFixed(5))),
  k2: quantise(k2),
  kb2: Array.from(kb2, (v) => Number(v.toFixed(5))),
  fw: quantise(fw),
  fb: Array.from(fb, (v) => Number(v.toFixed(5))),
};

writeFileSync("src/vision/glyph-model.json", JSON.stringify(model));
console.log(`\nwrote src/vision/glyph-model.json (${(JSON.stringify(model).length / 1024).toFixed(0)} KB)`);
