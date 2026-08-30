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

/**
 * The letters a game can ask for.
 *
 * German is a first-class target, so the umlauts are in the alphabet rather
 * than bolted on: they change the model's shape, the printed sheet, and — most
 * of all — how a glyph has to be found, because the two dots are not connected
 * to the letter under them and a blob finder hands them over separately.
 */
export const DEFAULT_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ";
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
export interface NormaliseOptions {
  /**
   * Ignore ink that runs off the edge of the crop.
   *
   * For a crop taken from inside a tile, anything touching the border came from
   * outside — the neighbouring tile's frame, most often. It has to go, and not
   * because it is untidy: the bounding box is taken over everything dark, so a
   * single stray bar down one side widens the box and the letter is scaled down
   * to sit beside it. Half the alphabet came back shrunk and misread that way.
   *
   * Being a flood fill rather than a margin, it keeps what a margin would cost:
   * the two dots of an umlaut float clear of the letter and clear of the edge,
   * so they survive, and the crop can stay generous enough to contain them.
   */
  dropEdgeTouching?: boolean;
}

export function normaliseGlyph(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  opts: NormaliseOptions = {},
): Uint8Array {
  const threshold = otsu(gray);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = gray[i] <= threshold ? 1 : 0;
  if (opts.dropEdgeTouching) clearFromEdges(ink, w, h);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ink[y * w + x]) {
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
      out[y * GLYPH_SIZE + x] = ink[sy * w + sx];
    }
  }

  return out;
}

/** Flood-fill every run of ink that reaches the border, and erase it. */
function clearFromEdges(ink: Uint8Array, w: number, h: number): void {
  const stack: number[] = [];
  const push = (i: number) => {
    if (ink[i]) {
      ink[i] = 0;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
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
