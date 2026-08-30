/**
 * Reading the calibration card, once it has been found and squared up.
 *
 * Everything here was a constant somewhere in the codebase, chosen from one
 * photograph of one rig and then shipped to everybody. This turns each into a
 * measurement of the rig in front of it.
 *
 * The card is rectified first, by the same homography machinery the play area
 * uses, so a patch that the layout says is at (0.10, 0.20) really is at
 * (0.10 * width, 0.20 * height) in the buffer this reads. That is worth more
 * than the arithmetic it saves: the alternative is a second implementation of
 * where things are, and two descriptions of the same geometry drift.
 */

import {
  CARD_WIDTH_MM, EDGE, type Patch, RULES, SWATCHES, TILE, TILE_BORDER_MM, WEDGE,
} from "./card.js";

export interface RigProfile {
  /** Per-channel gain that takes the camera's white back to white. */
  gain: { r: number; g: number; b: number };
  /** What the ink detector should use on this rig, rather than the shipped guess. */
  ink: { contrast: number; maxLuma: number };
  /** Millimetres per card pixel, so anything printed converts to real size. */
  mmPerPixel: number;
  /** How far the lens smears an edge, in card pixels: the 10-90% rise. */
  blur: number;
  /** The token inks as this camera sees them, after the gain above. */
  palette: Array<{ name: string; rgb: [number, number, number] }>;
  /** Where the measurement is weak, so the app can say so rather than pretend. */
  warnings: string[];
}

const px = (p: Patch, w: number, h: number) => ({
  x0: Math.round(p.x * w), y0: Math.round(p.y * h),
  x1: Math.round((p.x + p.w) * w), y1: Math.round((p.y + p.h) * h),
});

function meanRgb(rgba: Uint8ClampedArray, w: number, p: Patch, W: number, H: number, inset = 0.2) {
  const r = px(p, W, H);
  const dx = Math.round((r.x1 - r.x0) * inset);
  const dy = Math.round((r.y1 - r.y0) * inset);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = r.y0 + dy; y < r.y1 - dy; y++) {
    for (let x = r.x0 + dx; x < r.x1 - dx; x++) {
      const i = (y * w + x) * 4;
      sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]; n++;
    }
  }
  return n ? ([sr / n, sg / n, sb / n] as [number, number, number]) : ([0, 0, 0] as [number, number, number]);
}

const luma = (c: [number, number, number]) => (c[0] * 77 + c[1] * 150 + c[2] * 29) / 256;

export function measureCard(rgba: Uint8ClampedArray, W: number, H: number): RigProfile {
  const warnings: string[] = [];

  // ---- exposure, from the grey wedge
  const white = meanRgb(rgba, W, WEDGE[0].patch, W, H);
  const mid = meanRgb(rgba, W, WEDGE[1].patch, W, H);
  const black = meanRgb(rgba, W, WEDGE[2].patch, W, H);
  const peak = Math.max(white[0], white[1], white[2]) || 1;
  const gain = { r: peak / (white[0] || 1), g: peak / (white[1] || 1), b: peak / (white[2] || 1) };
  // Bare paper, so anything at the very top of the range is the exposure
  // clipping rather than the print being bright.
  if (Math.max(white[0], white[1], white[2]) > 253) {
    warnings.push("the white patch is clipped; the lamp is too bright to measure gain");
  }
  if (luma(white) - luma(black) < 40) {
    warnings.push("hardly any contrast between the white and black patches");
  }

  /*
   * ---- ink threshold, from the line pairs
   *
   * The detector calls a pixel ink when it falls a given fraction below the
   * mean of its neighbourhood. Each patch of rules is a known stroke weight, so
   * the modulation still visible in the finest one that has not turned to mush
   * is the smallest fraction worth asking for on this rig. Half of it, so a
   * stroke has to be clearly darker than its surroundings rather than merely
   * measurable.
   */
  const nearest = RULES.reduce((best, r) =>
    Math.abs(r.strokeMm - TILE_BORDER_MM) < Math.abs(best.strokeMm - TILE_BORDER_MM) ? r : best,
  );
  const r = px(nearest.patch, W, H);
  let lo = 255, sum = 0, n = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const v = rgba[(y * W + x) * 4];
      lo = Math.min(lo, v); sum += v; n++;
    }
  }
  const mean = n ? sum / n : 0;
  const modulation = mean > 0 ? (mean - lo) / mean : 0;
  if (modulation < 0.08) {
    warnings.push("the tile-border rule is not legible; the ink threshold is left at its default");
  }
  const ink = {
    // Half of what the border actually shows, so a hairline is comfortably ink
    // rather than marginally so — and capped well short of where raising it
    // starts breaking frames, which on one capture took the tile count from 37
    // to 27 between 0.12 and 0.20.
    contrast: modulation >= 0.08 ? clamp(modulation * 0.5, 0.05, 0.16) : 0.12,
    maxLuma: clamp(luma(white) * 0.92, 120, 250),
  };

  // ---- scale, from the card's own width
  const mmPerPixel = CARD_WIDTH_MM / W;

  /*
   * ---- blur, from the slanted edge
   *
   * How far it takes the edge to go from nearly-paper to nearly-ink, averaged
   * over the rows. Slanted, so each row crosses at a different sub-pixel offset
   * and the average sees between the pixels rather than only across them.
   */
  const e = px(EDGE.patch, W, H);
  const rises: number[] = [];
  for (let y = e.y0 + 2; y < e.y1 - 2; y++) {
    let lo = 255, hi = 0;
    for (let x = e.x0; x < e.x1; x++) {
      const v = rgba[(y * W + x) * 4];
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    if (hi - lo < 30) continue;
    const at = (frac: number) => {
      const target = lo + (hi - lo) * frac;
      for (let x = e.x0; x < e.x1 - 1; x++) {
        const a = rgba[(y * W + x) * 4];
        const b = rgba[(y * W + x + 1) * 4];
        if ((a - target) * (b - target) <= 0 && a !== b) return x + (target - a) / (b - a);
      }
      return NaN;
    };
    const rise = Math.abs(at(0.9) - at(0.1));
    if (Number.isFinite(rise)) rises.push(rise);
  }
  rises.sort((a, b) => a - b);
  const blur = rises.length ? rises[Math.floor(rises.length / 2)] : NaN;
  if (!Number.isFinite(blur)) warnings.push("could not measure the lens blur from the slanted edge");

  // ---- palette, as this camera sees the real inks
  const palette = SWATCHES.map((s) => {
    const c = meanRgb(rgba, W, s.patch, W, H);
    return {
      name: s.name,
      rgb: [
        clamp(c[0] * gain.r, 0, 255), clamp(c[1] * gain.g, 0, 255), clamp(c[2] * gain.b, 0, 255),
      ] as [number, number, number],
    };
  });

  void mid; void TILE;
  return { gain, ink, mmPerPixel, blur: Number.isFinite(blur) ? blur : 0, palette, warnings };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
