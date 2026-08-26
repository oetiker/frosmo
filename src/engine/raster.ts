/**
 * Polygon rasterisation into a mask.
 *
 * Games that ask the player to *match* something — cover this shape, fill this
 * outline — need their target in the same representation the camera produces,
 * so the comparison is one mask against another rather than geometry against
 * pixels.
 */

import type { Mask } from "../vision/mask.js";

/** Polygon in board units: [x0, y0, x1, y1, ...]. */
export type Polygon = number[];

/**
 * Scanline fill with the even-odd rule, sampling at pixel centres.
 *
 * Even-odd rather than nonzero winding so a shape can carry a hole by listing
 * the hole as another ring, without the caller minding which way round it is
 * wound.
 */
export function fillPolygons(mask: Mask, polygons: Polygon[], unitsPerPixel: number): void {
  const { w, h, data } = mask;
  data.fill(0);
  const crossings: number[] = [];

  for (let y = 0; y < h; y++) {
    const py = (y + 0.5) * unitsPerPixel;
    crossings.length = 0;

    for (const poly of polygons) {
      const n = poly.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = poly[i * 2];
        const ay = poly[i * 2 + 1];
        const j = (i + 1) % n;
        const bx = poly[j * 2];
        const by = poly[j * 2 + 1];
        // Half-open test on y: a vertex exactly on the scanline is counted once,
        // not twice, which is what keeps a shape from developing a seam.
        if (ay <= py === by <= py) continue;
        crossings.push(ax + ((py - ay) / (by - ay)) * (bx - ax));
      }
    }

    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(crossings[i] / unitsPerPixel - 0.5));
      const x1 = Math.min(w - 1, Math.floor(crossings[i + 1] / unitsPerPixel - 0.5));
      for (let x = x0; x <= x1; x++) data[y * w + x] = 1;
    }
  }
}

/** Scale and centre a polygon set so it fills a fraction of the board. */
export function fitPolygons(polygons: Polygon[], boardW: number, boardH: number, margin = 0.12): Polygon[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i += 2) {
      minX = Math.min(minX, poly[i]);
      maxX = Math.max(maxX, poly[i]);
      minY = Math.min(minY, poly[i + 1]);
      maxY = Math.max(maxY, poly[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return polygons;

  const availW = boardW * (1 - margin * 2);
  const availH = boardH * (1 - margin * 2);
  const scale = Math.min(availW / (maxX - minX || 1), availH / (maxY - minY || 1));
  const offX = (boardW - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (boardH - (maxY - minY) * scale) / 2 - minY * scale;

  return polygons.map((poly) => {
    const out: Polygon = new Array(poly.length);
    for (let i = 0; i < poly.length; i += 2) {
      out[i] = poly[i] * scale + offX;
      out[i + 1] = poly[i + 1] * scale + offY;
    }
    return out;
  });
}
