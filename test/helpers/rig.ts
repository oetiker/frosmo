/**
 * The viewing angle of a real rig, taken from a photograph rather than imagined.
 *
 * Everything else in these tests places the card at an angle somebody chose.
 * This one is measured: a frame from the tablet looking at the play area, with
 * the printed tile sheet in it. That sheet is a known grid — 24 mm pitch, A at
 * the top left, 9 at the bottom right — so four of its glyph centres give a
 * homography from millimetres on that table to pixels in that camera.
 *
 * It matters because the angle is much flatter than a camera on a tripod. A
 * printed circle arrives at 1.2 to 1 near the tablet and 1.7 to 1 at the far
 * edge of the same sheet, which is where "only the lower two marks get found"
 * came from: the limit was 1.7.
 */
import { CARD_HEIGHT_MM, CARD_WIDTH_MM } from "../../src/vision/card.js";
import { applyHomography, solveHomography, type Quad } from "../../src/vision/homography.js";

export const RIG_FRAME = { w: 1280, h: 720 };

/** Glyph centres on the sheet, in millimetres, and where they land in the frame. */
const SHEET: Quad = [
  { x: 0, y: 0 },
  { x: 168, y: 0 },
  { x: 144, y: 96 },
  { x: 0, y: 96 },
];
const IN_FRAME: Quad = [
  { x: 372, y: 281 },
  { x: 957, y: 281 },
  { x: 951, y: 553 },
  { x: 286, y: 553 },
];

export const tableToFrame = solveHomography(SHEET, IN_FRAME);

/**
 * A `place` for `drawCard`, putting the card on that table.
 *
 * @param back  millimetres further from the tablet than the middle of the sheet
 * @param turn  degrees the card is rotated as it lies there
 * @param scale shrink the card, for a smaller print
 */
export function onRig(back = 0, turn = 0, scale = 1) {
  const cx = 168 / 2;
  const cy = 96 / 2 - back;
  const cos = Math.cos((turn * Math.PI) / 180);
  const sin = Math.sin((turn * Math.PI) / 180);
  return (u: number, v: number) => {
    const dx = (u - 0.5) * CARD_WIDTH_MM * scale;
    const dy = (v - 0.5) * CARD_HEIGHT_MM * scale;
    return applyHomography(tableToFrame, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
  };
}
