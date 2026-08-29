/**
 * The trained glyph recogniser, at inference.
 *
 * Template matching counts overlapping pixels. That is why it could not
 * separate D from O on a real sheet: they overlap almost everywhere and differ
 * in one straight edge a few pixels wide, which contributes a handful of
 * pixels either way. Restricting the alphabet and preferring upright readings
 * removed the confusions that were artificial; these are the ones that are not.
 *
 * So the shipped recogniser is a small convolutional network — about 22,000
 * parameters, 60KB of int8 weights, trained on the app's own letterforms
 * degraded the way a tablet camera degrades a printed tile. The forward pass is
 * written out here in full: it costs a few hundred microseconds per glyph, and
 * a framework to run it would be twenty times the size of the whole app.
 *
 * Training lives in tools/train-glyphs.ts; the weights are generated, and
 * committed so that a clone needs no browser and no training run to work.
 */

import model from "./glyph-model.json";

interface Quantised {
  scale: number;
  data: number[];
}

/** Undo the int8 quantisation the trainer applied. */
function dequantise(q: Quantised): Float32Array {
  const out = new Float32Array(q.data.length);
  for (let i = 0; i < q.data.length; i++) out[i] = q.data[i] * q.scale;
  return out;
}

const CHARS = [...model.chars];
const S = model.input;
const S2 = S / 2;
const S4 = S / 4;
const C1 = model.c1;
const C2 = model.c2;
const POOLED = S4 * S4 * C2;

const k1 = dequantise(model.k1);
const kb1 = Float32Array.from(model.kb1);
const k2 = dequantise(model.k2);
const kb2 = Float32Array.from(model.kb2);
const fw = dequantise(model.fw);
const fb = Float32Array.from(model.fb);

// Allocated once: recognition runs on every candidate of every frame.
const a0 = new Float32Array(S * S);
const z1 = new Float32Array(C1 * S * S);
const p1 = new Float32Array(C1 * S2 * S2);
const z2 = new Float32Array(C2 * S2 * S2);
const p2 = new Float32Array(POOLED);
const scores = new Float32Array(CHARS.length);

export interface NetResult {
  char: string;
  /** Probability of the winner, 0-1. */
  confidence: number;
  /** How far ahead of the runner-up, 0-1. */
  margin: number;
}

/** Same-size 3x3 convolution followed by a ReLU. */
function conv(
  input: Float32Array,
  inC: number,
  size: number,
  kernel: Float32Array,
  bias: Float32Array,
  outC: number,
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

function pool(input: Float32Array, ch: number, size: number, out: Float32Array): void {
  const half = size / 2;
  for (let c = 0; c < ch; c++) {
    const ib = c * size * size;
    const ob = c * half * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const a = input[ib + y * 2 * size + x * 2];
        const b = input[ib + y * 2 * size + x * 2 + 1];
        const c2 = input[ib + (y * 2 + 1) * size + x * 2];
        const d = input[ib + (y * 2 + 1) * size + x * 2 + 1];
        out[ob + y * half + x] = Math.max(Math.max(a, b), Math.max(c2, d));
      }
    }
  }
}

/**
 * Read one normalised glyph.
 *
 * `allowed`, when given, restricts the answer to the characters a game uses.
 * It masks the softmax rather than filtering afterwards, which is the stronger
 * form: a letter is never asked to out-score a digit it will never be shown
 * next to. This is the same argument as restricting the colour palette, and it
 * was worth several percent of accuracy in training.
 */
export function readGlyph(sample: Uint8Array, allowed?: string): NetResult | null {
  if (sample.length !== S * S) return null;

  for (let i = 0; i < S * S; i++) a0[i] = sample[i];
  conv(a0, 1, S, k1, kb1, C1, z1);
  pool(z1, C1, S, p1);
  conv(p1, C1, S2, k2, kb2, C2, z2);
  pool(z2, C2, S2, p2);

  let max = -Infinity;
  for (let c = 0; c < CHARS.length; c++) {
    if (allowed && !allowed.includes(CHARS[c])) {
      scores[c] = -Infinity;
      continue;
    }
    let s = fb[c];
    const row = c * POOLED;
    for (let i = 0; i < POOLED; i++) s += fw[row + i] * p2[i];
    scores[c] = s;
    if (s > max) max = s;
  }
  if (max === -Infinity) return null;

  let sum = 0;
  for (let c = 0; c < CHARS.length; c++) {
    scores[c] = scores[c] === -Infinity ? 0 : Math.exp(scores[c] - max);
    sum += scores[c];
  }

  let best = 0;
  let second = -1;
  for (let c = 0; c < CHARS.length; c++) {
    if (scores[c] > scores[best]) {
      second = best;
      best = c;
    } else if (second < 0 || scores[c] > scores[second]) {
      second = c;
    }
  }

  const top = scores[best] / sum;
  const runnerUp = second >= 0 ? scores[second] / sum : 0;
  return { char: CHARS[best], confidence: top, margin: top - runnerUp };
}

/** What the model scored on held-out synthetic data, for the vision lab. */
export const MODEL_ACCURACY = model.accuracy;
export const MODEL_CHARS = model.chars;
