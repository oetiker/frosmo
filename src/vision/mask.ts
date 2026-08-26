/**
 * Binary masks in board space, and the morphology the detectors share.
 *
 * All passes are separable or in-place with a single scratch buffer: at board
 * resolution the whole pipeline has to fit comfortably inside one 30fps frame
 * alongside a game, on an iPad that is also driving the display.
 */

export interface Mask {
  readonly w: number;
  readonly h: number;
  /** 1 = foreground, 0 = background. */
  readonly data: Uint8Array;
}

export function createMask(w: number, h: number): Mask {
  return { w, h, data: new Uint8Array(w * h) };
}

export function clearMask(m: Mask): void {
  m.data.fill(0);
}

export function copyMask(src: Mask, dst: Mask): void {
  dst.data.set(src.data);
}

export function countMask(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

/** Intersection over union — how well two masks agree. Used for shape matching. */
export function iou(a: Mask, b: Mask): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i];
    const y = b.data[i];
    if (x & y) inter++;
    if (x | y) union++;
  }
  return union === 0 ? 0 : inter / union;
}

/** Fraction of `target` that `covered` fills, ignoring anything outside the target. */
export function coverage(target: Mask, covered: Mask): number {
  let want = 0;
  let got = 0;
  for (let i = 0; i < target.data.length; i++) {
    if (!target.data[i]) continue;
    want++;
    if (covered.data[i]) got++;
  }
  return want === 0 ? 0 : got / want;
}

/** Fraction of `covered` that falls outside `target` — the overspill a player is penalised for. */
export function spill(target: Mask, covered: Mask): number {
  let total = 0;
  let out = 0;
  for (let i = 0; i < covered.data.length; i++) {
    if (!covered.data[i]) continue;
    total++;
    if (!target.data[i]) out++;
  }
  return total === 0 ? 0 : out / total;
}

/**
 * 3x3 min filter, done as two separable passes.
 *
 * Erosion is what removes the single-pixel speckle that sensor noise and JPEG
 * ringing leave in the difference image. One pass of open() is worth more than
 * any amount of threshold tuning.
 */
export function erode(m: Mask, scratch: Uint8Array): void {
  const { w, h, data } = m;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? data[row + x - 1] : 0;
      const c = data[row + x];
      const r = x < w - 1 ? data[row + x + 1] : 0;
      scratch[row + x] = l & c & r;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const u = y > 0 ? scratch[row - w + x] : 0;
      const c = scratch[row + x];
      const d = y < h - 1 ? scratch[row + w + x] : 0;
      data[row + x] = u & c & d;
    }
  }
}

/** 3x3 max filter, separable, mirroring erode(). */
export function dilate(m: Mask, scratch: Uint8Array): void {
  const { w, h, data } = m;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? data[row + x - 1] : 0;
      const c = data[row + x];
      const r = x < w - 1 ? data[row + x + 1] : 0;
      scratch[row + x] = l | c | r;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const u = y > 0 ? scratch[row - w + x] : 0;
      const c = scratch[row + x];
      const d = y < h - 1 ? scratch[row + w + x] : 0;
      data[row + x] = u | c | d;
    }
  }
}

/** Remove speckle: erode then dilate, `times` rounds of each. */
export function open(m: Mask, scratch: Uint8Array, times = 1): void {
  for (let i = 0; i < times; i++) erode(m, scratch);
  for (let i = 0; i < times; i++) dilate(m, scratch);
}

/** Close pinholes: dilate then erode. Keeps a pencil outline from leaking. */
export function close(m: Mask, scratch: Uint8Array, times = 1): void {
  for (let i = 0; i < times; i++) dilate(m, scratch);
  for (let i = 0; i < times; i++) erode(m, scratch);
}

/**
 * Box blur of a mask into a float field in [0,1].
 *
 * Physics needs a smooth surface normal, and a hard binary mask has none: its
 * gradient is either zero or a cliff. Blurring first turns the obstacle into a
 * field whose gradient points out of it, which is exactly the collision normal.
 */
export function blurToField(m: Mask, out: Float32Array, radius = 2): void {
  const { w, h, data } = m;
  const tmp = new Float32Array(w * h);
  const norm = 1 / (radius * 2 + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += data[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum -= data[row + clamp(x - radius, 0, w - 1)];
      sum += data[row + clamp(x + radius + 1, 0, w - 1)];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum -= tmp[clamp(y - radius, 0, h - 1) * w + x];
      sum += tmp[clamp(y + radius + 1, 0, h - 1) * w + x];
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
