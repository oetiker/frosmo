/**
 * Connected-component labelling: from "these pixels are covered" to
 * "these are the four things on the table".
 *
 * Iterative flood fill with an explicit stack — recursion blows up on a mask
 * that is one large connected region, which is the normal case when a hand is
 * in the frame.
 */

import type { Mask } from "./mask.js";

export interface Blob {
  readonly id: number;
  /** Pixel count. */
  area: number;
  /** Centre of mass, in board pixels. */
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Mean colour over the blob, sampled from the rectified frame. */
  r: number;
  g: number;
  b: number;
  /** Orientation of the principal axis, radians, and how elongated the blob is. */
  angle: number;
  elongation: number;
}

/** Reusable working buffers, so the per-frame path allocates nothing. */
export interface LabelScratch {
  labels: Int32Array;
  stack: Int32Array;
}

export function createLabelScratch(w: number, h: number): LabelScratch {
  return { labels: new Int32Array(w * h), stack: new Int32Array(w * h) };
}

export interface LabelResult {
  blobs: Blob[];
  /** Per-pixel blob id, 0 = background. Same dimensions as the input mask. */
  labels: Int32Array;
}

export interface LabelOptions {
  /** Discard components smaller than this, in pixels. Kills residual noise. */
  minArea?: number;
  /** Discard components larger than this fraction of the board — usually an arm across the frame. */
  maxAreaFraction?: number;
  /** Rectified RGBA at board resolution; when given, blobs carry their mean colour. */
  rgba?: Uint8ClampedArray;
  /** Cap on returned blobs, largest first. */
  limit?: number;
  /** Working buffers to reuse; one is allocated per call when omitted. */
  scratch?: LabelScratch;
}

export function labelBlobs(mask: Mask, opts: LabelOptions = {}): LabelResult {
  const { w, h, data } = mask;
  const minArea = opts.minArea ?? 24;
  const maxArea = (opts.maxAreaFraction ?? 0.6) * w * h;
  const reuse = opts.scratch && opts.scratch.labels.length >= w * h;
  const labels = reuse ? opts.scratch!.labels : new Int32Array(w * h);
  const stack = reuse ? opts.scratch!.stack : new Int32Array(w * h);
  if (reuse) labels.fill(0);
  const blobs: Blob[] = [];
  let next = 1;

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start]) continue;

    const id = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let sr = 0;
    let sg = 0;
    let sb = 0;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;

      area++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (opts.rgba) {
        const o = p * 4;
        sr += opts.rgba[o];
        sg += opts.rgba[o + 1];
        sb += opts.rgba[o + 2];
      }

      // 4-connectivity: diagonal links would merge tokens that merely touch
      // corner to corner, which happens constantly with tiles pushed together.
      if (x > 0 && data[p - 1] && !labels[p - 1]) (labels[p - 1] = id), (stack[sp++] = p - 1);
      if (x < w - 1 && data[p + 1] && !labels[p + 1]) (labels[p + 1] = id), (stack[sp++] = p + 1);
      if (y > 0 && data[p - w] && !labels[p - w]) (labels[p - w] = id), (stack[sp++] = p - w);
      if (y < h - 1 && data[p + w] && !labels[p + w]) (labels[p + w] = id), (stack[sp++] = p + w);
    }

    if (area < minArea || area > maxArea) {
      // Leave the labels in place; callers that care read `blobs`, and
      // rewriting the label image for a rejected component costs another pass.
      continue;
    }

    const cx = sumX / area;
    const cy = sumY / area;
    const vxx = sumXX / area - cx * cx;
    const vyy = sumYY / area - cy * cy;
    const vxy = sumXY / area - cx * cy;
    const { angle, elongation } = principalAxis(vxx, vyy, vxy);

    blobs.push({
      id,
      area,
      cx,
      cy,
      minX,
      minY,
      maxX,
      maxY,
      r: opts.rgba ? sr / area : 0,
      g: opts.rgba ? sg / area : 0,
      b: opts.rgba ? sb / area : 0,
      angle,
      elongation,
    });
  }

  blobs.sort((a, b) => b.area - a.area);
  return { blobs: opts.limit ? blobs.slice(0, opts.limit) : blobs, labels };
}

/**
 * Eigen-decomposition of the 2x2 covariance matrix.
 *
 * The angle deskews a tile before glyph matching; the elongation ratio tells a
 * token (roughly round or square) from a pen stroke (long and thin).
 */
function principalAxis(vxx: number, vyy: number, vxy: number): { angle: number; elongation: number } {
  const diff = vxx - vyy;
  const angle = 0.5 * Math.atan2(2 * vxy, diff);
  const common = Math.sqrt(diff * diff + 4 * vxy * vxy);
  const major = (vxx + vyy + common) / 2;
  const minor = (vxx + vyy - common) / 2;
  const elongation = minor <= 1e-6 ? Infinity : Math.sqrt(major / minor);
  return { angle, elongation };
}
