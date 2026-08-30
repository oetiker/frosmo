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
import { applyHomography, solveHomography, type Quad } from "./homography.js";

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

/**
 * How flat a circle is allowed to arrive.
 *
 * A camera looking at a plane squashes it by the sine of the angle it looks
 * down at: 1.4 to 1 at forty-five degrees, 2 to 1 at thirty, 2.9 to 1 at
 * twenty. A mirror rig is not a camera on a tripod looking straight down — it
 * is a reflector clipped over a tablet, looking along the table almost as much
 * as at it — so the marks arrive as ellipses, and the far pair much flatter
 * than the near pair.
 *
 * The first version allowed 1.7, and on a photograph of a real rig the two far
 * marks measured 1.68 and 1.71: one detected, one not, from the same card. The
 * two near ones came in at 1.23 and were never in doubt. That is the whole of
 * the "only the lower two get marked" report.
 *
 * Four and a half is about fifteen degrees, which is flatter than anything
 * still worth playing on: below that the tiles hide each other and there are
 * not enough pixels left across a glyph to read it. The cost of allowing it is
 * more candidates to sift, and the sifting — four extremes plus a fifth mark
 * where the perspective says it should be — does not care how many it is given.
 */
const MAX_SQUASH = 4.5;

export interface Ring {
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
  return choose(findRings(gray, w, h, opts));
}

/**
 * Every ring-shaped mark in the frame, before any of them is believed.
 *
 * Split out from `findCard` so a failure can be described instead of merely
 * reported. "No card found" is the same sentence whether the card is face down
 * in another room or one ring short because a hand is resting on it, and those
 * want opposite things from the person holding the tablet.
 */
export function findRings(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  opts: FindCardOptions = {},
): Ring[] {
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
    // Size is judged on the long axis. A squashed circle keeps its width and
    // loses its height, so testing both against one lower bound would rule out
    // exactly the far marks that the angle has already made hardest.
    const long = Math.max(bw, bh);
    const shortSide = Math.min(bw, bh);
    if (long < minRing || long > maxRing) continue;
    if (shortSide < Math.max(4, minRing / MAX_SQUASH)) continue;
    if (long / shortSide > MAX_SQUASH) continue;
    const fill = b.area / (bw * bh);
    if (fill < RING_FILL * 0.55 || fill > RING_FILL * 1.6) continue;
    // Hollow: the middle of the box is background, and stays background a
    // little way out, so a letter with one small counter does not qualify.
    const cx = Math.round((b.minX + b.maxX) / 2);
    const cy = Math.round((b.minY + b.maxY) / 2);
    // Probed as an ellipse, not a square: the hole is squashed by exactly as
    // much as the mark around it, so a square sized by the shorter axis would
    // shrink to nothing on the very marks that need the most care.
    const probeX = Math.max(1, Math.round(bw * 0.12));
    const probeY = Math.max(1, Math.round(bh * 0.12));
    let hollow = true;
    for (let dy = -probeY; dy <= probeY && hollow; dy++) {
      for (let dx = -probeX; dx <= probeX; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || ink.mask.data[y * w + x]) {
          hollow = false;
          break;
        }
      }
    }
    if (!hollow) continue;
    /*
     * The corners of the bounding box, which a ring never reaches into and a
     * rectangle always does.
     *
     * Without this a printed colour swatch qualifies. The adaptive threshold
     * lights only the swatch's edges — its interior is not darker than its own
     * neighbourhood — so what reaches the blob finder is a hollow rectangle of
     * a ring's size, a ring's aspect and very nearly a ring's fill. A ring's
     * ink lies inside its outer circle, and the corner of the box that circle
     * is inscribed in is 13% of a radius outside it; a rectangle's ink runs
     * right through. One corner is allowed, for a mark with something touching
     * it.
     *
     * The probe sits near the corner rather than well inside it, and that is
     * the safe direction on both counts: further out is further clear of a
     * ring's own ink, and a rectangle's ink runs all the way to the corner
     * anyway. On one rendered card it took the candidate list from eight marks
     * to the five that are really there.
     */
    const inset = 0.06;
    let filledCorners = 0;
    for (const [px, py] of [
      [b.minX + bw * inset, b.minY + bh * inset],
      [b.maxX - bw * inset, b.minY + bh * inset],
      [b.maxX - bw * inset, b.maxY - bh * inset],
      [b.minX + bw * inset, b.maxY - bh * inset],
    ]) {
      const x = Math.round(px);
      const y = Math.round(py);
      if (x >= 0 && y >= 0 && x < w && y < h && ink.mask.data[y * w + x]) filledCorners++;
    }
    if (filledCorners > 1) continue;

    rings.push({ x: cx, y: cy, size: Math.max(bw, bh) });
  }

  return rings;
}

/**
 * Pick the five that are the card, and put them in order.
 *
 * The first version took the candidate nearest each corner of their own
 * bounding box. That works for a card lying square to the frame and quietly
 * stops working as it turns: at forty-five degrees the card is a diamond, its
 * marks sit at the top, right, bottom and left of the box rather than in its
 * corners, and the fifth mark is as near a box corner as any of them. Five
 * perfectly good marks, and the wrong four chosen.
 *
 * Four marks at the corners of a rectangle are, under any perspective, the four
 * that enclose the most area — the fifth lies between two of them and swapping
 * it in can only lose area. So: hull the candidates, take the four-subsets in
 * descending area, and accept the first that a spare mark vouches for by
 * sitting where the perspective says the key must be. That is rotation-proof,
 * and it survives junk on the table: a stray ring can only win by making a
 * bigger quadrilateral than the card's, and then it still has to produce a key.
 */
function choose(rings: Ring[]): CardSighting | null {
  if (rings.length < 5) return null;

  // The corner marks are on the hull; the key is not, so a hull of fewer than
  // four points is not a card.
  const outer = hull(rings);
  if (outer.length < 4) return null;
  // Enough to hold the card's four plus a table's worth of clutter, and few
  // enough that every four-subset can be tried.
  const pool = outer.length > 12 ? largestSpread(outer, 12) : outer;

  const marks = FIDUCIALS.map((f) => ({ x: f.cx, y: f.cy })) as Quad;
  const quads: Array<{ pick: Ring[]; area: number }> = [];
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      for (let c = b + 1; c < pool.length; c++) {
        for (let d = c + 1; d < pool.length; d++) {
          // Hull order is already a simple polygon, so the four keep their
          // cyclic order and the shoelace area is the real one.
          const pick = [pool[a], pool[b], pool[c], pool[d]];
          quads.push({ pick, area: Math.abs(shoelace(pick)) });
        }
      }
    }
  }
  quads.sort((x, y) => y.area - x.area);

  for (const { pick, area } of quads) {
    const spare = rings.filter((r) => !pick.includes(r));
    if (!spare.length) continue;
    for (let turn = 0; turn < 4; turn++) {
      for (const mirrored of [false, true]) {
        const order = mirrored
          ? [pick[(4 - turn) % 4], pick[(3 - turn + 4) % 4], pick[(2 - turn + 4) % 4], pick[(1 - turn + 4) % 4]]
          : [pick[turn % 4], pick[(turn + 1) % 4], pick[(turn + 2) % 4], pick[(turn + 3) % 4]];
        let want;
        try {
          want = applyHomography(
            solveHomography(marks, order.map((r) => ({ x: r.x, y: r.y })) as Quad),
            KEY.cx,
            KEY.cy,
          );
        } catch {
          // Four marks that do not make a quadrilateral: not a card, whatever
          // sits near them.
          continue;
        }
        /*
         * How close the key has to be, judged against the distance it is
         * predicted to sit from the corner it belongs to rather than against
         * the card as a whole. Under a steep view that corner may be a third
         * the size of the opposite one, and a tolerance taken from the whole
         * card would be looser there than the gap it is meant to resolve. The
         * floor keeps a distant card from demanding sub-pixel agreement.
         */
        const reach = Math.hypot(want.x - order[0].x, want.y - order[0].y);
        const tol = Math.max(reach * 0.4, Math.sqrt(area) * 0.035);
        for (const s of spare) {
          if (Math.hypot(s.x - want.x, s.y - want.y) > tol) continue;
          return {
            quad: order.map((r) => ({ x: r.x, y: r.y })) as Quad,
            key: { x: s.x, y: s.y },
            mirrored,
          };
        }
      }
    }
  }
  return null;
}

/** Signed area of a polygon, twice over; only its magnitude and sign are used. */
function shoelace(p: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    sum += p[i].x * q.y - q.x * p[i].y;
  }
  return sum / 2;
}

/** Convex hull, counter-clockwise in image coordinates. Andrew's monotone chain. */
function hull(points: Ring[]): Ring[] {
  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (sorted.length < 3) return sorted;
  const cross = (o: Ring, a: Ring, b: Ring) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (pts: Ring[]) => {
    const out: Ring[] = [];
    for (const p of pts) {
      while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** Thin a crowded hull down to the `keep` points that span it most widely. */
function largestSpread(points: Ring[], keep: number): Ring[] {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x / points.length;
    cy += p.y / points.length;
  }
  return [...points]
    .sort((a, b) => Math.hypot(b.x - cx, b.y - cy) - Math.hypot(a.x - cx, a.y - cy))
    .slice(0, keep)
    // Put them back in hull order, so a four-subset is still a simple polygon.
    .sort((a, b) => points.indexOf(a) - points.indexOf(b));
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
