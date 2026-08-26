/**
 * Sampling the occupancy field.
 *
 * Physics needs two things from the mask that a binary array cannot give: a
 * value between the pixels, and a direction pointing out of the obstacle. The
 * pipeline supplies a blurred field; this samples it bilinearly and takes its
 * gradient, which is the surface normal of whatever is on the table — a wooden
 * block, a drawn line, a child's hand, all the same to a bouncing ball.
 */

export interface FieldRef {
  data: Float32Array;
  w: number;
  h: number;
}

/** Bilinear sample. Outside the board reads as empty. */
export function sampleField(f: FieldRef, x: number, y: number): number {
  const { data, w, h } = f;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;

  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];

  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/**
 * Gradient by central differences, normalised.
 *
 * Points *out* of the obstacle (towards lower occupancy), which is the
 * collision normal. Returns a zero vector where the field is flat, and callers
 * treat that as "no usable normal" rather than inventing one.
 */
export function fieldNormal(
  f: FieldRef,
  x: number,
  y: number,
  step = 1.5,
  out = { x: 0, y: 0 },
): { x: number; y: number } {
  const gx = sampleField(f, x - step, y) - sampleField(f, x + step, y);
  const gy = sampleField(f, x, y - step) - sampleField(f, x, y + step);
  const len = Math.hypot(gx, gy);
  if (len < 1e-4) {
    out.x = 0;
    out.y = 0;
  } else {
    out.x = gx / len;
    out.y = gy / len;
  }
  return out;
}
