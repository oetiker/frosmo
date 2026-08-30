/**
 * The calibration card: one description, used to print it and to read it.
 *
 * Everything the app currently guesses about a rig — where the play area is,
 * which way round the mirror puts it, how the camera is exposing, what survives
 * the ink threshold, how big a tile comes out, how much the lens blurs, what
 * the token inks look like through all of that — is a property of somebody's
 * particular table, lamp and reflector. The app has been shipping numbers
 * measured once, on one rig, from one photograph, and asking the player to make
 * up the rest with sliders.
 *
 * A printed card turns each of those into a measurement. The card is laid on
 * the play area, photographed once, and every number falls out of known marks
 * in known places.
 *
 * This file is the single description of where those marks are, in card
 * coordinates: x and y from 0 to 1 across the printed card, origin top left.
 * The printer lays the card out from it and the detector looks for patches at
 * it. If the two ever disagreed the calibration would be confidently wrong in a
 * way nothing downstream could detect — which is the failure this whole session
 * has been about — so they are not allowed to hold separate copies.
 */

/** A rectangle on the card, in card coordinates. */
export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The four registration marks, in the order a homography wants them:
 * top left, top right, bottom right, bottom left.
 *
 * Concentric rings rather than squares or corners. A ring survives being out of
 * focus — it stays a ring — where a corner rounds off and a small square fills
 * in, and its centre can be recovered to better than a pixel from the centroid
 * of the hole even when the whole mark is a grey smudge. They are also cheap to
 * find with machinery the pipeline already has: a ring is a blob with a blob
 * inside it, which is what contour nesting means.
 */
export const FIDUCIALS: ReadonlyArray<{ cx: number; cy: number }> = [
  { cx: 0.08, cy: 0.08 },
  { cx: 0.92, cy: 0.08 },
  { cx: 0.92, cy: 0.92 },
  { cx: 0.08, cy: 0.92 },
];

/** Outer and inner radius of a ring, as a fraction of the card's short side. */
export const FIDUCIAL_OUTER = 0.055;
export const FIDUCIAL_INNER = 0.028;

/**
 * A fifth mark, off-centre, which is what makes the card unambiguous.
 *
 * Four marks at the corners of a rectangle look the same rotated by 180 degrees
 * and the same again seen in a mirror, and a reflector rig is a mirror. One
 * extra ring nearer the top left than any other corner breaks both symmetries:
 * whichever corner it is closest to is the top left, and which way round the
 * others run tells you the handedness.
 */
export const KEY = { cx: 0.22, cy: 0.08 };

/**
 * Grey wedge, for exposure and white balance.
 *
 * Three patches rather than one: a white one alone cannot tell a dim lamp from
 * a dark print, and the app corrects the camera's own gain per channel, which
 * needs a neutral it can trust at more than one level.
 *
 * Densities, not luma values. The white patch is bare paper — nothing printed —
 * because paper is the brightest thing a printer can produce, and a patch asked
 * to be brighter than its own paper is either a lie or a clipped exposure. The
 * first draft asked for 255 and every clean card came back warning that the
 * lamp was too bright.
 */
export const WEDGE: ReadonlyArray<{ patch: Patch; density: number }> = [
  { patch: { x: 0.10, y: 0.20, w: 0.12, h: 0.10 }, density: 0 },
  { patch: { x: 0.24, y: 0.20, w: 0.12, h: 0.10 }, density: 0.5 },
  { patch: { x: 0.38, y: 0.20, w: 0.12, h: 0.10 }, density: 1 },
];

/**
 * Line pairs, thinning left to right, in the weights a printed tile actually
 * uses — from the hairline of a tile's border to the stroke of a glyph.
 *
 * The ink detector's threshold decides which of these survive, and on the rig
 * that threshold is close to a cliff: nudged across its plausible range it took
 * the tile count on one capture from 37 to 27. Reading off which pairs are
 * still separate at this distance, in this light, sets it from evidence.
 */
/** The weight of a printed tile's border: the line the detector must not lose. */
export const TILE_BORDER_MM = 0.4;

export const RULES: ReadonlyArray<{ patch: Patch; strokeMm: number }> = [
  { patch: { x: 0.10, y: 0.34, w: 0.09, h: 0.10 }, strokeMm: 1.2 },
  { patch: { x: 0.21, y: 0.34, w: 0.09, h: 0.10 }, strokeMm: 0.8 },
  { patch: { x: 0.32, y: 0.34, w: 0.09, h: 0.10 }, strokeMm: 0.5 },
  { patch: { x: 0.43, y: 0.34, w: 0.09, h: 0.10 }, strokeMm: 0.3 },
  { patch: { x: 0.54, y: 0.34, w: 0.09, h: 0.10 }, strokeMm: 0.2 },
];

/**
 * A tile of exactly the size the app prints, carrying a glyph.
 *
 * Two things come out of it. How many board pixels a real tile spans, which is
 * what the glyph and tile size limits ought to be derived from rather than
 * guessed as fractions of the board; and, from the sharpness of the glyph's own
 * edges, how much this lens blurs — the number the trainer's degradation is
 * currently guessing at.
 */
export const TILE = { patch: { x: 0.64, y: 0.20, w: 0.14, h: 0.14 }, glyph: "E", sizeMm: 22 };

/**
 * A slanted edge, for blur.
 *
 * Slanted on purpose, and by an angle that is not a neat fraction of a pixel:
 * an edge running along the pixel grid tells you nothing between one pixel and
 * the next, where a slanted one crosses the grid at every row and so samples
 * the lens at a hundred sub-pixel offsets at once.
 */
export const EDGE = { patch: { x: 0.82, y: 0.20, w: 0.10, h: 0.16 }, degrees: 7 };

/** The token inks, printed so the palette can be measured through this camera. */
export const SWATCHES: ReadonlyArray<{ patch: Patch; name: string; css: string }> = [
  { patch: { x: 0.10, y: 0.50, w: 0.10, h: 0.10 }, name: "red", css: "#d7263d" },
  { patch: { x: 0.22, y: 0.50, w: 0.10, h: 0.10 }, name: "orange", css: "#f2b705" },
  { patch: { x: 0.34, y: 0.50, w: 0.10, h: 0.10 }, name: "green", css: "#2a9d3f" },
  { patch: { x: 0.46, y: 0.50, w: 0.10, h: 0.10 }, name: "blue", css: "#1d5fd7" },
];

/**
 * Card proportions and size: A4's shape, at a size that fits half a sheet.
 *
 * Small on purpose, and smaller than the play area. Two things pushed it here.
 *
 * A card 297 mm across cannot come out of a printer that cannot print to the
 * paper's edge, which is nearly all of them: asked for one, the driver silently
 * scales the page. Everything else on the card survives being scaled — it is
 * all proportions — but this number does not, and it is the one that turns
 * board pixels into millimetres.
 *
 * And a card that fills the view is a card that might not fit in it. A rig
 * whose mirror sees a little less than expected loses a ring off the edge, and
 * a missing ring is not a degraded scan, it is no scan at all. Measured off one
 * real capture, the play area on the rig this was developed against is about
 * 192 by 144 mm; a card at 190 mm wide leaves that comfortable margin at the
 * cost of nothing, because the play area is no longer the card.
 *
 * It is grown from it instead — see `growPlayArea`. The card's four rings fix
 * the plane, the scale and the perspective; the play area is then the largest
 * rectangle on that same plane that still lands inside the camera's view. So
 * the card can be small enough to be certain of, and the board can still be as
 * big as the rig allows.
 */
export const CARD_ASPECT = 297 / 210;
export const CARD_WIDTH_MM = 190;
export const CARD_HEIGHT_MM = CARD_WIDTH_MM / CARD_ASPECT;
