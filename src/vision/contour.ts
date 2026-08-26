/**
 * Mask to outlines.
 *
 * Games draw what the camera sees at display resolution — 2732 pixels across
 * on an iPad Pro — while the mask is a couple of hundred pixels wide. Blitting
 * it looks like a scanned fax. Tracing the boundary and filling the polygons
 * instead gives clean edges at any zoom, and gives games real geometry to hang
 * effects on.
 */

import type { Mask } from "./mask.js";

export type Contour = number[]; // flat [x0, y0, x1, y1, ...] in board pixels

/**
 * Marching-squares boundary tracing.
 *
 * `scratch` is a reusable visited buffer of at least (w+1)*(h+1) bytes; pass
 * one from the per-frame path to avoid allocating it every frame.
 *
 * Walks each region's boundary once, keeping the interior on the right, and
 * marks visited boundary cells so a region with holes yields one loop per
 * boundary rather than the same loop repeatedly.
 */
export function traceContours(mask: Mask, minLength = 12, scratch?: Uint8Array): Contour[] {
  const { w, h, data } = mask;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[y * w + x]);

  // One cell per lattice corner: the square with corners (x-1,y-1)..(x,y).
  const cw = w + 1;
  const cells = cw * (h + 1);
  const visited = scratch && scratch.length >= cells ? scratch : new Uint8Array(cells);
  visited.fill(0, 0, cells);
  const out: Contour[] = [];

  for (let sy = 0; sy <= h; sy++) {
    for (let sx = 0; sx <= w; sx++) {
      if (visited[sy * cw + sx]) continue;
      if (cellCase(at, sx, sy) === 0 || cellCase(at, sx, sy) === 15) continue;

      const contour: Contour = [];
      let x = sx;
      let y = sy;

      for (let guard = 0; guard < w * h * 4; guard++) {
        if (x < 0 || y < 0 || x > w || y > h) break;
        const idx = y * cw + x;
        if (visited[idx] && contour.length > 0) break;
        visited[idx] = 1;
        contour.push(x, y);

        const c = cellCase(at, x, y);
        // Saddle cases (5 and 10) are resolved consistently rather than by
        // sampling the centre: an inconsistent choice tears the loop apart, and
        // at this resolution either resolution is visually identical.
        let dx = 0;
        let dy = 0;
        switch (c) {
          case 1:
          case 5:
          case 13:
            dx = 0;
            dy = -1;
            break;
          case 2:
          case 3:
          case 7:
            dx = 1;
            dy = 0;
            break;
          case 4:
          case 12:
          case 14:
            dx = 0;
            dy = 1;
            break;
          case 8:
          case 10:
          case 11:
            dx = -1;
            dy = 0;
            break;
          default:
            dx = 0;
            dy = 0;
        }
        if (dx === 0 && dy === 0) break;
        x += dx;
        y += dy;
        if (x === sx && y === sy) break;
      }

      if (contour.length >= minLength * 2) out.push(contour);
    }
  }

  return out;
}

/**
 * Case index of the 2x2 neighbourhood above-left of the lattice point.
 * Bit 1 = top-left, 2 = top-right, 4 = bottom-right, 8 = bottom-left.
 */
function cellCase(at: (x: number, y: number) => number, x: number, y: number): number {
  return (
    (at(x - 1, y - 1) ? 1 : 0) |
    (at(x, y - 1) ? 2 : 0) |
    (at(x, y) ? 4 : 0) |
    (at(x - 1, y) ? 8 : 0)
  );
}

/** Ramer–Douglas–Peucker simplification; drops the stair-steps tracing leaves behind. */
export function simplify(points: Contour, tolerance = 1): Contour {
  const n = points.length / 2;
  if (n < 3) return points;

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];

  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;

    const ax = points[a * 2];
    const ay = points[a * 2 + 1];
    const bx = points[b * 2];
    const by = points[b * 2 + 1];
    let best = -1;
    let bestD = tolerance;

    for (let i = a + 1; i < b; i++) {
      const d = pointSegmentDistance(points[i * 2], points[i * 2 + 1], ax, ay, bx, by);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }

    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }

  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  }
  return out;
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}
