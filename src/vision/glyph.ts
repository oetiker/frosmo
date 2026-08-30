/**
 * Turning a crop of a printed tile into something a recogniser can read.
 *
 * Only the preparation lives here — binarise, find the ink, scale it to a fixed
 * square. What reads the result is glyph-net.ts, a small trained network.
 *
 * This file once held a template matcher too, which compared the normalised
 * glyph against rendered letterforms by counting overlapping pixels. On a real
 * sheet that could not separate D from O: they overlap almost everywhere and
 * differ in a straight edge a few pixels wide. It was removed when the network
 * replaced it.
 *
 * The same normalisation is used when training, imported rather than
 * reimplemented — train on one preprocessing and infer with another and the
 * model is reading a different alphabet from the one it learned.
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
