/**
 * Projective (homography) transforms.
 *
 * The rig geometry — where the mirror sits, how far the iPad leans back, which
 * edge the camera is on — is never modelled explicitly. All of it collapses
 * into one 3x3 projective transform between *board space* (a normalised
 * rectangle covering the play area on the table) and *camera space* (pixels in
 * the frame the mirror delivers). Calibration finds that transform once; every
 * later stage works in board space and is rig-agnostic.
 */

export interface Point {
  x: number;
  y: number;
}

/** Row-major 3x3 matrix. */
export type Mat3 = Float64Array;

export type Quad = [Point, Point, Point, Point];

/**
 * Solve the homography H with dst ~ H * src for four point correspondences.
 *
 * Direct linear solve of the 8x8 system (h8 fixed at 1), with partial
 * pivoting. Four points is the minimum and the maximum here: calibration gives
 * us exactly the four corners of the play area, so there is nothing to
 * least-squares over.
 *
 * @throws if the correspondences are degenerate (three collinear points).
 */
export function solveHomography(src: Quad, dst: Quad): Mat3 {
  const a: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }

  const h = solveLinearSystem(a, b);
  return Float64Array.of(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1);
}

/** Gaussian elimination with partial pivoting. Mutates copies, not the input. */
function solveLinearSystem(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      throw new Error("degenerate point configuration: cannot solve homography");
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const d = m[col][col];
    for (let k = col; k <= n; k++) m[col][k] /= d;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = m[row][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) m[row][k] -= f * m[col][k];
    }
  }

  return m.map((row) => row[n]);
}

/** Map a point through H. Returns the dehomogenised result. */
export function applyHomography(h: Mat3, x: number, y: number, out: Point = { x: 0, y: 0 }): Point {
  const w = h[6] * x + h[7] * y + h[8];
  const iw = w === 0 ? 0 : 1 / w;
  out.x = (h[0] * x + h[1] * y + h[2]) * iw;
  out.y = (h[3] * x + h[4] * y + h[5]) * iw;
  return out;
}

/** Matrix inverse via the adjugate. H is only defined up to scale, so no normalisation is needed. */
export function invertHomography(h: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i;
  const B = f * g - d * j;
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("singular homography");
  const s = 1 / det;
  return Float64Array.of(
    A * s,
    (c * i - b * j) * s,
    (b * f - c * e) * s,
    B * s,
    (a * j - c * g) * s,
    (c * d - a * f) * s,
    C * s,
    (b * g - a * i) * s,
    (a * e - b * d) * s,
  );
}

/** The unit square, the canonical board-space quad: top-left, top-right, bottom-right, bottom-left. */
export function unitQuad(): Quad {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
}

/**
 * Reorder four points into TL, TR, BR, BL as seen in the image.
 *
 * The corner handles can be dragged past each other, and a quad whose corners
 * are in the wrong order maps the board mirrored or rotated. Sorting by angle
 * around the centroid fixes the winding; picking the start corner by
 * (x + y) fixes the phase.
 */
export function orderQuad(points: Quad): Quad {
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;

  const sorted = [...points].sort(
    (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
  );

  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }

  return [
    sorted[start],
    sorted[(start + 1) % 4],
    sorted[(start + 2) % 4],
    sorted[(start + 3) % 4],
  ] as Quad;
}

/** Twice the signed area of the quad; near zero means the corners are collapsed or collinear. */
export function quadArea(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    sum += p.x * n.y - n.x * p.y;
  }
  return Math.abs(sum) / 2;
}
