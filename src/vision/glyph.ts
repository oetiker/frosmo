/**
 * Reading printed tiles — letters and digits.
 *
 * This is the least forgiving of the four detectors, so it is built to fail
 * loudly rather than confidently wrong: every match carries the margin over the
 * runner-up, and callers are expected to reject thin margins instead of acting
 * on a coin-flip between O and 0.
 *
 * The templates are *rendered in the browser*, not shipped as data. That has
 * one large consequence: the printable tile sheet this app generates uses the
 * same renderer, so tiles printed from the app are matched against templates
 * drawn with identical letterforms. Recognition of our own tiles is then close
 * to exact, and third-party tiles (Osmo's own, or hand-written) degrade
 * gracefully from there.
 */

export const DEFAULT_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DEFAULT_DIGITS = "0123456789";

/** Side length of a normalised glyph, in pixels. 24 is enough to separate B from 8. */
export const GLYPH_SIZE = 24;

/**
 * The letterform the atlas is drawn in.
 *
 * Exported because the printable tile sheet must use the identical stack: that
 * is what makes tiles printed from this app match the templates it matches
 * against.
 */
export const GLYPH_FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

export interface GlyphAtlas {
  readonly chars: string[];
  /** One GLYPH_SIZE * GLYPH_SIZE binary bitmap per character. */
  readonly templates: Uint8Array[];
  readonly font: string;
}

export interface MatchOptions {
  /**
   * Penalty applied to a match found at a quarter turn, so upright wins ties.
   * Zero restores a straight contest between all four orientations.
   */
  rotationPenalty?: number;
}

export interface GlyphMatch {
  char: string;
  /** Agreement with the winning template, 0-1. */
  score: number;
  /** How far ahead of the runner-up, 0-1. Low means ambiguous — reject it. */
  margin: number;
  /** Quarter turns applied to the sample before it matched. */
  rotation: 0 | 1 | 2 | 3;
}

/**
 * Render a template atlas with the canvas 2D API.
 *
 * Drawn at 4x and downsampled so the binarised template keeps the stroke
 * weights of the real letterform instead of the aliasing of a 24px render.
 */
export function buildAtlas(
  chars: string,
  font = `700 ${GLYPH_SIZE * 4}px ${GLYPH_FONT_STACK}`,
): GlyphAtlas {
  const scale = 4;
  const size = GLYPH_SIZE * scale;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const templates: Uint8Array[] = [];
  const list = [...chars];

  for (const ch of list) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ch, size / 2, size / 2);

    const { data } = ctx.getImageData(0, 0, size, size);
    const gray = new Uint8ClampedArray(size * size);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      gray[i] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
    }
    templates.push(normaliseGlyph(gray, size, size));
  }

  return { chars: list, templates, font };
}

/**
 * Crop to the ink, scale to a square, binarise.
 *
 * Normalising by the ink's own bounding box is what makes a tile photographed
 * at an angle, half a centimetre closer to the mirror, comparable to a template
 * rendered on a desktop. It also throws away the tile's border, which carries
 * no information and varies between tile sets.
 */
export function normaliseGlyph(gray: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const threshold = otsu(gray);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] <= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const out = new Uint8Array(GLYPH_SIZE * GLYPH_SIZE);
  if (maxX < minX) return out;

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // Preserve aspect: an "I" squashed to fill a square becomes an "H"-shaped blob.
  const scale = Math.min((GLYPH_SIZE - 2) / bw, (GLYPH_SIZE - 2) / bh);
  const offX = (GLYPH_SIZE - bw * scale) / 2;
  const offY = (GLYPH_SIZE - bh * scale) / 2;

  for (let y = 0; y < GLYPH_SIZE; y++) {
    const sy = Math.round((y - offY) / scale) + minY;
    if (sy < minY || sy > maxY) continue;
    for (let x = 0; x < GLYPH_SIZE; x++) {
      const sx = Math.round((x - offX) / scale) + minX;
      if (sx < minX || sx > maxX) continue;
      out[y * GLYPH_SIZE + x] = gray[sy * w + sx] <= threshold ? 1 : 0;
    }
  }

  return out;
}

/**
 * Otsu's method: the threshold that best separates the luma histogram.
 *
 * Returns `t` such that the dark class is `value <= t` — note the inclusive
 * bound. For a clean two-tone tile the optimum lands exactly on the ink's own
 * value, so comparing with `<` instead classifies the entire glyph as
 * background and normalises the tile to nothing.
 */
export function otsu(gray: Uint8ClampedArray): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }

  return best;
}

/**
 * Match a normalised sample against the atlas, trying all four quarter turns.
 *
 * A square tile's principal axis is ambiguous modulo 90 degrees, so upstream
 * deskewing can only get the tile axis-aligned, never upright. Rotating here is
 * cheaper and more reliable than guessing there — and it means a tile dropped
 * sideways still reads.
 */
export function matchGlyph(
  sample: Uint8Array,
  atlas: GlyphAtlas,
  opts: MatchOptions = {},
): GlyphMatch | null {
  if (atlas.chars.length === 0) return null;

  // How much better a sideways reading must be before it beats an upright one.
  //
  // Trying every quarter turn is what lets a tile dropped sideways still read,
  // but on a sheet of upright letters it invents ambiguity that is not there:
  // M and W are the same shape turned over, as are N and Z, and 6 and 9. Left
  // to a straight contest those pairs trade places on noise. Upright is the
  // overwhelmingly common case, so it wins ties and near-ties, and a rotated
  // reading has to earn it.
  const rotationPenalty = opts.rotationPenalty ?? 0.08;

  let bestScore = -1;
  let bestChar = "";
  let bestRot: 0 | 1 | 2 | 3 = 0;
  let secondScore = -1;

  for (let rot = 0; rot < 4; rot++) {
    const rotated = rot === 0 ? sample : rotateQuarter(sample, rot as 1 | 2 | 3);
    for (let i = 0; i < atlas.templates.length; i++) {
      const score = agreement(rotated, atlas.templates[i]) - (rot === 0 ? 0 : rotationPenalty);
      if (score > bestScore) {
        // Only a different character counts as a runner-up: the same letter
        // scoring well at two rotations is agreement, not ambiguity.
        if (atlas.chars[i] !== bestChar) secondScore = bestScore;
        bestScore = score;
        bestChar = atlas.chars[i];
        bestRot = rot as 0 | 1 | 2 | 3;
      } else if (score > secondScore && atlas.chars[i] !== bestChar) {
        secondScore = score;
      }
    }
  }

  if (bestScore <= 0) return null;
  const margin = secondScore <= 0 ? 1 : Math.max(0, (bestScore - secondScore) / bestScore);
  return { char: bestChar, score: bestScore, margin, rotation: bestRot };
}

/** Intersection over union of the two ink sets. */
export function agreement(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x & y) inter++;
    if (x | y) union++;
  }
  return union === 0 ? 0 : inter / union;
}

export function rotateQuarter(src: Uint8Array, turns: 1 | 2 | 3): Uint8Array {
  const n = GLYPH_SIZE;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = src[y * n + x];
      if (!v) continue;
      let nx: number;
      let ny: number;
      if (turns === 1) {
        nx = n - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = n - 1 - x;
        ny = n - 1 - y;
      } else {
        nx = y;
        ny = n - 1 - x;
      }
      out[ny * n + nx] = 1;
    }
  }
  return out;
}
