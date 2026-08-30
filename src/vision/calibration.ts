/**
 * Calibration: the only thing that knows about the physical rig.
 *
 * Four corners of the play area, marked once by dragging handles over the live
 * camera image, plus an orientation. That is the entire rig model. No mirror
 * geometry, no assumption about which edge the camera sits on, no per-iPad
 * table of camera offsets — an Osmo base with the 2021 reflector, a hand-cut
 * mirror on a book stand, and a phone propped against a mug all calibrate the
 * same way.
 *
 * Corners are stored normalised to the frame (0..1), not in pixels, so
 * switching capture resolution — or the browser silently giving a different
 * one after a backgrounding — does not invalidate a calibration.
 */

import {
  orderQuad,
  quadArea,
  solveHomography,
  unitQuad,
  type Mat3,
  type Point,
  type Quad,
} from "./homography.js";
import type { RigProfile } from "./card-profile.js";
import type { BoardSize } from "./rectify.js";
import { load, remove, save } from "../util/storage.js";

export const CALIBRATION_VERSION = 1;

/**
 * How the play area is oriented relative to the image.
 *
 * 0-3 are quarter turns; 4-7 are the same after a horizontal flip. The flip is
 * not optional extra credit: a mirror rig reverses handedness, so without it
 * every game would be left-right reversed, and whether it is reversed depends
 * on whether the light bounces once (a reflector) or not at all (a phone
 * looking down at the table).
 */
export type Orientation = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Calibration {
  version: number;
  /** Play-area corners in normalised camera coordinates, ordered TL, TR, BR, BL. */
  corners: Quad;
  orientation: Orientation;
  /** Board aspect ratio, width / height. Matches the physical play area. */
  aspect: number;
  /** Board buffer width in pixels; height follows from the aspect. */
  resolution: number;
  /**
   * The camera this calibration was made with.
   *
   * Four corners are only meaningful in the frame they were marked in. Point a
   * different camera at the table — a back camera, an external webcam — and
   * they describe nothing. Recording the device lets the app say so instead of
   * letting the games mis-see the board. Optional: calibrations made before
   * the camera picker existed simply do not have it, and are trusted.
   */
  cameraId?: string;
  /** Human-readable name of that camera, for when the id has rotated. */
  cameraLabel?: string;
  /**
   * What the calibration card measured about this rig.
   *
   * Optional, and stays optional: a calibration made by dragging the handles
   * has no card behind it, and everything downstream falls back to the shipped
   * defaults when it is missing. Those defaults are one rig's numbers from one
   * photograph — fine as a starting point, wrong as a claim about anybody
   * else's table, which is the whole reason the card exists.
   */
  profile?: RigProfile;
  /**
   * How big the play area is in real life, in millimetres.
   *
   * Only a card scan knows this — dragging handles over a camera image says
   * where the play area is but nothing about how large. It is what lets the
   * detectors reason in millimetres: a printed tile is 22 mm whatever the
   * board resolution is, so with this the tile finder can be told the size to
   * expect instead of guessing a fraction of the board.
   */
  playAreaMm?: { w: number; h: number };
  createdAt: number;
}

const STORE_KEY = "calibration";

export function defaultCalibration(): Calibration {
  // A trapezoid, wider at the bottom: what a mirror looking down at a table
  // actually returns, and close enough that the handles need nudging, not
  // hunting.
  return {
    version: CALIBRATION_VERSION,
    corners: [
      { x: 0.22, y: 0.3 },
      { x: 0.78, y: 0.3 },
      { x: 0.95, y: 0.88 },
      { x: 0.05, y: 0.88 },
    ],
    orientation: 0,
    aspect: 4 / 3,
    resolution: 256,
    createdAt: 0,
  };
}

export function loadCalibration(): Calibration | null {
  const cal = load<Calibration | null>(STORE_KEY, null);
  if (!cal || cal.version !== CALIBRATION_VERSION || !Array.isArray(cal.corners)) return null;
  if (cal.corners.length !== 4) return null;
  return cal;
}

export function saveCalibration(cal: Calibration): boolean {
  return save(STORE_KEY, { ...cal, createdAt: cal.createdAt || Date.now() });
}

export function clearCalibration(): void {
  remove(STORE_KEY);
}

/** Board buffer dimensions implied by a calibration. */
export function boardSize(cal: Calibration): BoardSize {
  const w = Math.max(64, Math.round(cal.resolution));
  return { w, h: Math.max(48, Math.round(w / cal.aspect)) };
}

/**
 * Reorder the corners so board space lands the way the player expects.
 *
 * Applied to the destination quad rather than by post-transforming the board:
 * one array permutation instead of another matrix in the per-pixel path.
 */
export function orient(corners: Quad, orientation: Orientation): Quad {
  const flipped: Quad =
    orientation >= 4
      ? [corners[1], corners[0], corners[3], corners[2]]
      : [corners[0], corners[1], corners[2], corners[3]];
  const k = orientation % 4;
  return [flipped[k % 4], flipped[(k + 1) % 4], flipped[(k + 2) % 4], flipped[(k + 3) % 4]];
}

/** The homography from board space (unit square) to camera pixels. */
export function boardToCamera(cal: Calibration, srcW: number, srcH: number): Mat3 {
  const pixels = cal.corners.map((c) => ({ x: c.x * srcW, y: c.y * srcH })) as Quad;
  return solveHomography(unitQuad(), orient(pixels, cal.orientation));
}

/** Normalise, order and sanity-check dragged corners before they are stored. */
export function normaliseCorners(points: Quad, srcW: number, srcH: number): Quad | null {
  const normalised = points.map((p) => ({
    x: clamp01(p.x / srcW),
    y: clamp01(p.y / srcH),
  })) as Quad;
  const ordered = orderQuad(normalised);
  // A quad covering under 2% of the frame is a mis-drag, not a play area, and
  // it would blow the rectified image up into a handful of source pixels.
  if (quadArea(ordered) < 0.02) return null;
  return ordered;
}

export function cornersToPixels(cal: Calibration, srcW: number, srcH: number): Quad {
  return cal.corners.map((c) => ({ x: c.x * srcW, y: c.y * srcH })) as Quad;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export type { Point, Quad };
