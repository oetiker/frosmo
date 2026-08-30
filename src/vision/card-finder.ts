/**
 * Finding the calibration card in a raw camera frame.
 *
 * This is the one piece of the pipeline that has to work with nothing known.
 * Everywhere else there is already a calibration: the play area is a known
 * quadrilateral, the board is rectified, exposure has been corrected. Here
 * there is a photograph of somebody's table, at an unknown angle, under an
 * unknown lamp, possibly through a mirror that has flipped it, and the card is
 * somewhere in it.
 *
 * So the marks have to be findable on their own terms. A ring is:
 *
 *   - roughly as wide as it is tall, whatever the perspective, because
 *     perspective across a card this size skews a circle into an ellipse but
 *     not into a line;
 *   - hollow — its bounding box has background at the centre — which almost
 *     nothing else printed on a table is;
 *   - filled to a predictable fraction of its box, which the geometry fixes:
 *     an annulus of these radii covers about three fifths of its bounding
 *     square, and a solid blot or a letter does not.
 *
 * Five of them, and the fifth is what makes the answer unique. Four marks at
 * the corners of a rectangle are unchanged by turning the card upside down and
 * unchanged again by reflecting it, and a reflector rig reflects. The fifth
 * ring sits along the top edge, nearer the top-left corner than any other, so
 * the corner closest to it is the top left and the way round the rest run says
 * whether the image is mirrored.
 */

import { labelBlobs } from "./blobs.js";
import { CARD_ASPECT, FIDUCIAL_INNER, FIDUCIAL_OUTER, FIDUCIALS, KEY } from "./card.js";
import type { Calibration } from "./calibration.js";
import { InkDetector } from "./ink.js";
import type { Quad } from "./homography.js";

export interface CardSighting {
  /** The four registration marks in frame pixels, ordered TL, TR, BR, BL. */
  quad: Quad;
  /** The fifth mark, which fixed the ordering. */
  key: { x: number; y: number };
  /** True when the card was seen reflected, as a mirror rig shows it. */
  mirrored: boolean;
}

export interface FindCardOptions {
  /** Smallest ring to consider, as a fraction of the frame's short side. */
  minRing?: number;
  maxRing?: number;
  /** How far below the local mean a pixel must fall to count as ink. */
  contrast?: number;
}

/** Fraction of its bounding box an annulus of the card's radii covers. */
const RING_FILL = (Math.PI / 4) * (1 - (FIDUCIAL_INNER / FIDUCIAL_OUTER) ** 2);

interface Ring {
  x: number;
  y: number;
  size: number;
}

export function findCard(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  opts: FindCardOptions = {},
): CardSighting | null {
  const short = Math.min(w, h);
  const minRing = (opts.minRing ?? 0.02) * short;
  const maxRing = (opts.maxRing ?? 0.25) * short;

  const ink = new InkDetector(w, h, {
    radius: Math.max(6, Math.round(short / 24)),
    contrast: opts.contrast ?? 0.12,
    maxLuma: 235,
    bridge: 0,
  });
  ink.detect(gray);

  const rings: Ring[] = [];
  for (const b of labelBlobs(ink.mask, { minArea: minRing * minRing * 0.2, limit: 400 }).blobs) {
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    if (bw < minRing || bh < minRing || bw > maxRing || bh > maxRing) continue;
    const aspect = bw / bh;
    if (aspect < 0.6 || aspect > 1.7) continue;
    const fill = b.area / (bw * bh);
    if (fill < RING_FILL * 0.55 || fill > RING_FILL * 1.6) continue;
    // Hollow: the middle of the box is background, and stays background a
    // little way out, so a letter with one small counter does not qualify.
    const cx = Math.round((b.minX + b.maxX) / 2);
    const cy = Math.round((b.minY + b.maxY) / 2);
    const probe = Math.max(1, Math.round(Math.min(bw, bh) * 0.12));
    let hollow = true;
    for (let dy = -probe; dy <= probe && hollow; dy++) {
      for (let dx = -probe; dx <= probe; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || ink.mask.data[y * w + x]) {
          hollow = false;
          break;
        }
      }
    }
    if (!hollow) continue;
    rings.push({ x: cx, y: cy, size: Math.max(bw, bh) });
  }

  return choose(rings);
}

/**
 * Pick the five that are the card, and put them in order.
 *
 * The four corners are the extreme ones: a convex hull would do it, but with a
 * handful of candidates the corner nearest each corner of their own bounding
 * box is simpler and behaves the same under perspective. The key is then
 * whichever remaining ring sits closest to where the card says it should be
 * once those four are believed.
 */
function choose(rings: Ring[]): CardSighting | null {
  if (rings.length < 5) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x);
    minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y);
  }
  const nearest = (px: number, py: number) =>
    rings.reduce((best, r) =>
      Math.hypot(r.x - px, r.y - py) < Math.hypot(best.x - px, best.y - py) ? r : best,
    );
  const corners = [
    nearest(minX, minY),
    nearest(maxX, minY),
    nearest(maxX, maxY),
    nearest(minX, maxY),
  ];
  if (new Set(corners).size !== 4) return null;

  // Where the key would be, on each of the four ways round the card that the
  // corners could be labelled. Whichever guess a spare ring actually sits at is
  // the right one — and it settles rotation and reflection together.
  const spare = rings.filter((r) => !corners.includes(r));
  if (!spare.length) return null;

  const along = (KEY.cx - FIDUCIALS[0].cx) / (FIDUCIALS[1].cx - FIDUCIALS[0].cx);
  let best: { order: Ring[]; key: Ring; d: number; mirrored: boolean } | null = null;
  for (let turn = 0; turn < 4; turn++) {
    for (const mirrored of [false, true]) {
      const order = mirrored
        ? [corners[(4 - turn) % 4], corners[(3 - turn + 4) % 4], corners[(2 - turn + 4) % 4], corners[(1 - turn + 4) % 4]]
        : [corners[turn % 4], corners[(turn + 1) % 4], corners[(turn + 2) % 4], corners[(turn + 3) % 4]];
      const wantX = order[0].x + (order[1].x - order[0].x) * along;
      const wantY = order[0].y + (order[1].y - order[0].y) * along;
      for (const s of spare) {
        const d = Math.hypot(s.x - wantX, s.y - wantY);
        if (!best || d < best.d) best = { order, key: s, d, mirrored };
      }
    }
  }
  if (!best) return null;
  // The key has to be where it was predicted, not merely closest: a stray ring
  // on the table would otherwise get to decide which way up the card is.
  const scale = Math.hypot(best.order[1].x - best.order[0].x, best.order[1].y - best.order[0].y);
  if (best.d > scale * 0.12) return null;

  return {
    quad: best.order.map((r) => ({ x: r.x, y: r.y })) as Quad,
    key: { x: best.key.x, y: best.key.y },
    mirrored: best.mirrored,
  };
}

/** Ring geometry, exported so the printer and the tests draw the same marks. */
export const RING = { outer: FIDUCIAL_OUTER, inner: FIDUCIAL_INNER };

/**
 * Turn a sighting into a calibration.
 *
 * The corners come back in card order however the card was lying, and the key
 * ring has already settled which way up and which way round — so the stored
 * orientation is zero. That is the point of the exercise: the Rotate and Mirror
 * buttons exist because nothing else could tell a reflected image from a
 * straight one, and a mark that is not symmetric can.
 */
export function calibrationFromCard(
  seen: CardSighting,
  frameW: number,
  frameH: number,
  cameraId?: string,
  cameraLabel?: string,
): Calibration {
  return {
    version: 1,
    corners: seen.quad.map((p) => ({
      x: Math.min(1, Math.max(0, p.x / frameW)),
      y: Math.min(1, Math.max(0, p.y / frameH)),
    })) as Quad,
    orientation: 0,
    aspect: CARD_ASPECT,
    resolution: 256,
    createdAt: Date.now(),
    cameraId,
    cameraLabel,
  };
}
