/**
 * Letterboxing, in one place.
 *
 * Three surfaces need the same answer: where the board sits on a game canvas,
 * where the calibration handles sit over the camera preview, and where a tap
 * lands in board coordinates. Getting it subtly different in one of them is how
 * the calibration handles end up offset from the image they are supposed to be
 * marking — invisible when the container happens to match the source's aspect,
 * and wrong on every other device.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest rect of the given aspect that fits inside the container, centred. */
export function letterbox(containerW: number, containerH: number, aspect: number): Rect {
  if (!(aspect > 0) || containerW <= 0 || containerH <= 0) {
    return { x: 0, y: 0, w: Math.max(0, containerW), h: Math.max(0, containerH) };
  }
  const scale = Math.min(containerW / aspect, containerH);
  const w = aspect * scale;
  const h = scale;
  return { x: (containerW - w) / 2, y: (containerH - h) / 2, w, h };
}

/** A point inside a rect, as 0..1 across and down it, clamped to the rect. */
export function normaliseInRect(rect: Rect, x: number, y: number): { x: number; y: number } {
  return {
    x: clamp01(rect.w === 0 ? 0 : (x - rect.x) / rect.w),
    y: clamp01(rect.h === 0 ? 0 : (y - rect.y) / rect.h),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
