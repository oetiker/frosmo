/**
 * One photograph of the card, in — a calibrated rig, out.
 *
 * The two halves already exist and neither knows about the other: `findCard`
 * says where the card is in the frame, `measureCard` says what a squared-up
 * card tells you about the camera. This is the join, and the join is where the
 * two subtle things live.
 *
 * The first is that the registration marks are inset from the paper — they sit
 * at 0.08 and 0.92 across the card — so the quad they form is *not* the card.
 * Rectify to that quad and every patch would be read 8% off in both
 * directions, which is enough to read the black patch as the mid-grey one. So
 * the homography is solved from the marks' own card coordinates rather than
 * from the unit square, and sampling the unit square through it then lands on
 * the paper.
 *
 * The second is that the play area is bigger than the card. See `growPlayArea`.
 */

import { CARD_ASPECT, CARD_HEIGHT_MM, CARD_WIDTH_MM, FIDUCIALS } from "./card.js";
import { findCard, type CardSighting, type FindCardOptions } from "./card-finder.js";
import { measureCard, type RigProfile } from "./card-profile.js";
import { CALIBRATION_VERSION, type Calibration } from "./calibration.js";
import { applyHomography, invertHomography, solveHomography, type Mat3, type Quad } from "./homography.js";
import { buildSampleTable, createRectifiedFrame, rectify, type RectifiedFrame } from "./rectify.js";

/** A rectangle on the card's plane, in card coordinates. May extend past the card. */
export interface PlaneRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface CardScan {
  calibration: Calibration;
  profile: RigProfile;
  sighting: CardSighting;
  /** Card coordinates to camera pixels. Valid across the whole table, not just the card. */
  cardToCamera: Mat3;
  /** The play area, on the card's plane. */
  area: PlaneRect;
  /** The card squared up, so the player can be shown what was actually read. */
  card: RectifiedFrame;
}

export interface ScanOptions extends FindCardOptions {
  /** Width of the buffer the card is read from. */
  cardWidth?: number;
  resolution?: number;
  cameraId?: string;
  cameraLabel?: string;
  /** Leave the play area at the card's own marks instead of growing it. */
  cardOnly?: boolean;
}

/** The marks' positions in card coordinates, in the order `findCard` reports them. */
const MARK_QUAD = FIDUCIALS.map((f) => ({ x: f.cx, y: f.cy })) as Quad;

export function scanCard(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: ScanOptions = {},
): CardScan | null {
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }

  const sighting = findCard(gray, w, h, opts);
  if (!sighting) return null;

  const cardToCamera = solveHomography(MARK_QUAD, sighting.quad);

  const cardW = Math.max(160, Math.round(opts.cardWidth ?? 640));
  const size = { w: cardW, h: Math.round(cardW / CARD_ASPECT) };
  const card = createRectifiedFrame(size);
  rectify(rgba, buildSampleTable(cardToCamera, size, w, h), card);

  const profile = measureCard(card.rgba, size.w, size.h);

  const marks: PlaneRect = {
    u0: FIDUCIALS[0].cx,
    v0: FIDUCIALS[0].cy,
    u1: FIDUCIALS[2].cx,
    v1: FIDUCIALS[2].cy,
  };
  const area = opts.cardOnly ? marks : growPlayArea(cardToCamera, w, h, marks);

  return {
    calibration: calibrationFor(area, cardToCamera, w, h, profile, opts),
    profile,
    sighting,
    cardToCamera,
    area,
    card,
  };
}

/** Turn a rectangle on the card's plane into a calibration for it. */
export function calibrationFor(
  area: PlaneRect,
  cardToCamera: Mat3,
  frameW: number,
  frameH: number,
  profile?: RigProfile,
  opts: { resolution?: number; cameraId?: string; cameraLabel?: string } = {},
): Calibration {
  const mm = playAreaMm(area);
  return {
    version: CALIBRATION_VERSION,
    corners: cornersOf(area, cardToCamera).map((p) => ({
      x: Math.min(1, Math.max(0, p.x / frameW)),
      y: Math.min(1, Math.max(0, p.y / frameH)),
    })) as Quad,
    // The corners come out in the card's own order — top left first, running
    // the way the printed card runs — so rectifying to them puts the board
    // upright and the right way round whether or not a mirror was involved.
    // That is what the sighting's `mirrored` was worked out for; nothing is
    // left to turn.
    orientation: 0,
    aspect: mm.w / mm.h,
    resolution: opts.resolution ?? 256,
    createdAt: Date.now(),
    cameraId: opts.cameraId,
    cameraLabel: opts.cameraLabel,
    profile,
    playAreaMm: mm,
  };
}

/** How big a rectangle on the card's plane is in real life. */
export function playAreaMm(area: PlaneRect): { w: number; h: number } {
  return {
    w: Math.abs(area.u1 - area.u0) * CARD_WIDTH_MM,
    h: Math.abs(area.v1 - area.v0) * CARD_HEIGHT_MM,
  };
}

/** The rectangle's corners in camera pixels, in TL, TR, BR, BL order. */
export function cornersOf(area: PlaneRect, cardToCamera: Mat3): Quad {
  const at = (u: number, v: number) => applyHomography(cardToCamera, u, v);
  return [
    at(area.u0, area.v0),
    at(area.u1, area.v0),
    at(area.u1, area.v1),
    at(area.u0, area.v1),
  ];
}

export interface GrowOptions {
  /** Keep the corners this far inside the frame, as a fraction of its short side. */
  margin?: number;
  /** How far the play area may run past the card, as a multiple of the card. */
  limit?: number;
  /** Step size, in card widths. */
  step?: number;
}

/**
 * Push the play area outwards from the card until it reaches the edge of view.
 *
 * The card is deliberately smaller than the table, so taking its marks as the
 * play area would give away a third of the board. But the card has already
 * established the whole plane it lies on: a homography is not a statement about
 * the paper, it is a statement about the surface, and it stays true off the
 * edge of the card in every direction. So the board is the largest rectangle on
 * that surface that the camera can still see.
 *
 * Each side is pushed out on its own, a step at a time, and stops when a corner
 * would leave the frame. Straight lines stay straight under a homography, so
 * four corners inside the frame really do mean the whole rectangle is inside
 * it — with one exception, which is the reason for the `w > 0` test: a plane
 * seen at a glancing angle has a horizon, and points beyond it come back
 * through the projection mirrored and behind the camera. Growing past that
 * would produce a quad that looks plausible and is nonsense.
 *
 * What this cannot know is where the *mirror* stops seeing, as opposed to the
 * camera. A reflector that vignettes will hand back dark corners inside a
 * perfectly valid frame. That is what the margin and the limit are for, and
 * why the calibrate screen still lets the handles be dragged afterwards.
 */
export function growPlayArea(
  cardToCamera: Mat3,
  frameW: number,
  frameH: number,
  from: PlaneRect,
  opts: GrowOptions = {},
): PlaneRect {
  const margin = (opts.margin ?? 0.02) * Math.min(frameW, frameH);
  const limit = opts.limit ?? 1.6;
  const step = opts.step ?? 0.01;

  const area: PlaneRect = { ...from };
  const bounds = {
    u0: from.u0 - limit,
    v0: from.v0 - limit / CARD_ASPECT,
    u1: from.u1 + limit,
    v1: from.v1 + limit / CARD_ASPECT,
  };

  const fits = (r: PlaneRect): boolean => {
    for (const [u, v] of [
      [r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1],
    ] as const) {
      // The homogeneous denominator, before the divide: negative means the
      // point is behind the camera, on the far side of the plane's horizon.
      const d = cardToCamera[6] * u + cardToCamera[7] * v + cardToCamera[8];
      if (!(d > 0)) return false;
      const p = applyHomography(cardToCamera, u, v);
      if (p.x < margin || p.y < margin || p.x > frameW - margin || p.y > frameH - margin) {
        return false;
      }
    }
    return true;
  };

  if (!fits(area)) return from;

  const sides: Array<[keyof PlaneRect, number, number]> = [
    ["u0", -step, bounds.u0],
    ["u1", step, bounds.u1],
    ["v0", -step / CARD_ASPECT, bounds.v0],
    ["v1", step / CARD_ASPECT, bounds.v1],
  ];
  for (const [side, delta, stop] of sides) {
    for (;;) {
      const next = area[side] + delta;
      if (delta < 0 ? next < stop : next > stop) break;
      const trial = { ...area, [side]: next };
      if (!fits(trial)) break;
      area[side] = next;
    }
  }
  return area;
}

/**
 * Where a quad of camera pixels lands on the card's plane.
 *
 * For after the handles have been dragged: the card is long gone, but the
 * plane it established is still there, so a hand-adjusted board can still be
 * measured in millimetres instead of falling back to guesswork.
 */
export function areaFromCorners(corners: Quad, cardToCamera: Mat3): PlaneRect {
  const inverse = invertHomography(cardToCamera);
  const pts = corners.map((c) => applyHomography(inverse, c.x, c.y));
  return {
    u0: Math.min(...pts.map((p) => p.x)),
    v0: Math.min(...pts.map((p) => p.y)),
    u1: Math.max(...pts.map((p) => p.x)),
    v1: Math.max(...pts.map((p) => p.y)),
  };
}
