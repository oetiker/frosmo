/**
 * From a photograph of the card to a calibrated board.
 *
 * The cases that matter here are the joins, not the parts: that the patches are
 * read off the paper and not off the quad of marks, that the play area grows
 * past the card without leaving the frame, and that a hand-dragged board can
 * still be measured once the card has established the plane.
 */
import { describe, expect, it } from "vitest";
import {
  areaFromCorners,
  cornersOf,
  growPlayArea,
  playAreaMm,
  scanCard,
} from "../src/vision/card-scan.js";
import { CARD_ASPECT, CARD_HEIGHT_MM, CARD_WIDTH_MM, FIDUCIALS, WEDGE } from "../src/vision/card.js";
import { solveHomography, type Quad } from "../src/vision/homography.js";
import { drawCard, perspective } from "./helpers/card.js";

const W = 640;
const H = 480;

/** Lay the card down covering `fill` of the frame's short side, with an optional tilt. */
function placer(fill = 0.9, tilt = 0) {
  const cardH = 1 / CARD_ASPECT;
  return (u: number, v: number) => {
    const shrink = 1 - tilt * (1 - v);
    const a = (u - 0.5) * shrink;
    const b = (v - 0.5) * cardH;
    const scale = Math.min(W * fill, (H * fill) / cardH);
    return { x: W / 2 + a * scale, y: H / 2 + b * scale };
  };
}

/** The grey card as an RGBA frame, which is what the app hands the scanner. */
function shoot(fill = 0.9, tilt = 0) {
  const drawn = drawCard(W, H, placer(fill, tilt));
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = drawn.gray[i];
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, drawn };
}

const MARKS: Quad = [
  { x: FIDUCIALS[0].cx, y: FIDUCIALS[0].cy },
  { x: FIDUCIALS[1].cx, y: FIDUCIALS[1].cy },
  { x: FIDUCIALS[2].cx, y: FIDUCIALS[2].cy },
  { x: FIDUCIALS[3].cx, y: FIDUCIALS[3].cy },
];

describe("scanCard", () => {
  it("reads the card and reports a rig profile", () => {
    const { rgba } = shoot(0.55);
    const seen = scanCard(rgba, W, H);
    expect(seen).not.toBeNull();
    // Read off the paper, not off the quad of marks: the wedge's black patch
    // has to come back dark. Eight per cent out in both directions and it
    // would be reading the mid-grey one instead.
    expect(seen!.profile.ink.contrast).toBeGreaterThan(0);
    expect(seen!.profile.warnings).not.toContain(
      "hardly any contrast between the white and black patches",
    );
  });

  it("grows the play area past the card, and keeps it in the frame", () => {
    const { rgba } = shoot(0.5);
    const seen = scanCard(rgba, W, H)!;
    const card = playAreaMm({ u0: FIDUCIALS[0].cx, v0: FIDUCIALS[0].cy, u1: FIDUCIALS[2].cx, v1: FIDUCIALS[2].cy });
    const board = seen.calibration.playAreaMm!;
    expect(board.w).toBeGreaterThan(card.w * 1.4);
    for (const c of seen.calibration.corners) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(1);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(1);
    }
    // The aspect reported has to be the aspect of the board that came out, not
    // the card's — a rectangle grown into a 4:3 frame is not A4-shaped.
    expect(seen.calibration.aspect).toBeCloseTo(board.w / board.h, 3);
  });

  it("leaves the play area at the card when asked", () => {
    const { rgba } = shoot(0.5);
    const seen = scanCard(rgba, W, H, { cardOnly: true })!;
    const mm = seen.calibration.playAreaMm!;
    expect(mm.w).toBeCloseTo((FIDUCIALS[1].cx - FIDUCIALS[0].cx) * CARD_WIDTH_MM, 6);
    expect(mm.h).toBeCloseTo((FIDUCIALS[2].cy - FIDUCIALS[1].cy) * CARD_HEIGHT_MM, 6);
  });

  it("declines when there is no card", () => {
    expect(scanCard(new Uint8ClampedArray(W * H * 4).fill(200), W, H)).toBeNull();
  });
});

describe("scanCard, seen at an angle", () => {
  /** The card's paper corners as a camera on a stand sees them: far edge shorter. */
  const tilted = (tilt: number): Quad => {
    const cardH = 1 / CARD_ASPECT;
    const scale = Math.min(W * 0.55, (H * 0.55) / cardH);
    const far = (scale / 2) * (1 - tilt);
    const y0 = H / 2 - (cardH * scale) / 2 + cardH * scale * tilt * 0.25;
    const y1 = H / 2 + (cardH * scale) / 2;
    return [
      { x: W / 2 - far, y: y0 },
      { x: W / 2 + far, y: y0 },
      { x: W / 2 + scale / 2, y: y1 },
      { x: W / 2 - scale / 2, y: y1 },
    ];
  };

  /**
   * The patches have to land on the patches, not merely near them.
   *
   * This is the case the four marks cannot vouch for. A homography can be
   * fitted through any four points, so the marks come out right even when the
   * map between them is wrong — and everything the profile reads is between
   * them. Squaring the card up and looking at the wedge is the check that the
   * whole plane, not just its corners, arrived.
   */
  it("reads the patches off the paper, not near it", () => {
    const drawn = drawCard(W, H, perspective(tilted(0.3)));
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = drawn.gray[i];
      rgba[i * 4 + 3] = 255;
    }
    const seen = scanCard(rgba, W, H)!;
    expect(seen).not.toBeNull();
    const { w, h } = seen.card.size;

    // Where the black patch's own edges landed, read down its centre column.
    // Its value at the centre is not the test: a reading half a patch out is
    // still black in the middle, and half a patch is the difference between
    // reading the wedge and reading the rules below it.
    const patch = WEDGE[2].patch;
    const column = Math.round((patch.x + patch.w / 2) * w);
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < Math.round(0.32 * h); y++) {
      if (seen.card.gray[y * w + column] < 60) {
        if (top < 0) top = y;
        bottom = y;
      }
    }
    expect(top / h).toBeCloseTo(patch.y, 2);
    expect(bottom / h).toBeCloseTo(patch.y + patch.h, 2);
  });
});

describe("growPlayArea", () => {
  const marks = { u0: FIDUCIALS[0].cx, v0: FIDUCIALS[0].cy, u1: FIDUCIALS[2].cx, v1: FIDUCIALS[2].cy };
  const homographyFor = (fill: number, tilt = 0) => {
    const place = placer(fill, tilt);
    return solveHomography(MARKS, MARKS.map((m) => place(m.x, m.y)) as Quad);
  };

  it("stops at the edge of the frame", () => {
    const m = homographyFor(0.4);
    const grown = growPlayArea(m, W, H, marks);
    const margin = 0.02 * Math.min(W, H);
    for (const p of cornersOf(grown, m)) {
      expect(p.x).toBeGreaterThanOrEqual(margin - 1);
      expect(p.y).toBeGreaterThanOrEqual(margin - 1);
      expect(p.x).toBeLessThanOrEqual(W - margin + 1);
      expect(p.y).toBeLessThanOrEqual(H - margin + 1);
    }
    // One more step on any side would have left it.
    const step = 0.01;
    const over = { ...grown, u1: grown.u1 + step * 3 };
    const outside = cornersOf(over, m).some(
      (p) => p.x < margin || p.y < margin || p.x > W - margin || p.y > H - margin,
    );
    expect(outside).toBe(true);
  });

  it("gives up rather than shrink, when the marks already run off the frame", () => {
    // A card too big for the view. There is nothing to grow into and nothing
    // to salvage: hand back what was asked for, and let the caller notice the
    // corners are outside.
    const m = homographyFor(1.25);
    expect(growPlayArea(m, W, H, marks)).toEqual(marks);
  });

  it("still grows when the card is seen at an angle", () => {
    const m = homographyFor(0.45, 0.3);
    const grown = growPlayArea(m, W, H, marks);
    expect(grown.u1 - grown.u0).toBeGreaterThan(marks.u1 - marks.u0);
    // A homography has a horizon; growing past it would fold the quad over
    // itself. The corners must still run the way round they started.
    const q = cornersOf(grown, m);
    const cross =
      (q[1].x - q[0].x) * (q[2].y - q[1].y) - (q[1].y - q[0].y) * (q[2].x - q[1].x);
    expect(cross).toBeGreaterThan(0);
  });
});

describe("areaFromCorners", () => {
  it("measures a hand-dragged board on the plane the card established", () => {
    const place = placer(0.5);
    const m = solveHomography(MARKS, MARKS.map((p) => place(p.x, p.y)) as Quad);
    const want = { u0: -0.2, v0: -0.1, u1: 1.3, v1: 0.8 };
    const back = areaFromCorners(cornersOf(want, m), m);
    expect(back.u0).toBeCloseTo(want.u0, 4);
    expect(back.v0).toBeCloseTo(want.v0, 4);
    expect(back.u1).toBeCloseTo(want.u1, 4);
    expect(back.v1).toBeCloseTo(want.v1, 4);
  });
});
