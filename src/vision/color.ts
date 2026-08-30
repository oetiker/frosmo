/**
 * Colour classification for tokens.
 *
 * Deliberately hue-first and coarse. The mirror is a cheap plastic surface, the
 * iPad's auto white balance drifts with the room, and a token seen at the far
 * edge of the play area is dimmer than one under the iPad's own glow. Anything
 * that keys on absolute RGB falls apart under those; hue plus a saturation
 * floor survives them, and a coarse eight-bucket palette is all a game needs.
 */

export interface Hsv {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
}

export type TokenColor =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "purple"
  | "pink"
  | "white"
  | "grey"
  | "black";

export interface ColorMatch {
  color: TokenColor;
  /** 0-1; how far the sample sits from the nearest bucket boundary. */
  confidence: number;
  hsv: Hsv;
}

export function rgbToHsv(r: number, g: number, b: number, out: Hsv = { h: 0, s: 0, v: 0 }): Hsv {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;

  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  out.h = h;
  out.s = max === 0 ? 0 : d / max;
  out.v = max;
  return out;
}

/** Hue centres, in the order a colour wheel visits them. */
const HUES: Array<{ color: TokenColor; hue: number }> = [
  { color: "red", hue: 0 },
  { color: "orange", hue: 30 },
  { color: "yellow", hue: 55 },
  { color: "green", hue: 120 },
  { color: "cyan", hue: 180 },
  { color: "blue", hue: 225 },
  { color: "purple", hue: 275 },
  { color: "pink", hue: 320 },
];

export interface ClassifyOptions {
  /** Below this saturation the sample is achromatic — white, grey or black. */
  minSaturation?: number;
  /** Below this value it is black regardless of hue. */
  blackBelow?: number;
  /** Above this value with low saturation it is white. */
  whiteAbove?: number;
  /**
   * Which colours this caller can actually be shown. Anything outside it is
   * not reported as the nearest member — it is not reported at all.
   */
  palette?: TokenColor[];
}

/**
 * Which bucket a sample belongs to, or null for "that is not a token".
 *
 * The null matters more than it looks. Every blob the occupancy mask finds gets
 * asked this question, and on a table with a sheet of paper on it most of those
 * blobs are paper. Given paper, a classifier that must answer says "white" —
 * correctly, and at high confidence, because paper is white — and the board
 * fills with tokens that are really just the tiles' own faces. That is the same
 * mistake as a 36-way letter model naming a border fragment, and it has the
 * same answer: let it decline.
 *
 * White, grey and black are therefore reported only when a caller says it might
 * see them. They are real colours, but on a white paper play surface an
 * achromatic blob is far more likely to be the surface than a piece on it, and
 * nothing downstream can tell the difference afterwards.
 */
export function classifyColor(
  r: number,
  g: number,
  b: number,
  opts: ClassifyOptions = {},
): ColorMatch | null {
  const minSaturation = opts.minSaturation ?? 0.28;
  const blackBelow = opts.blackBelow ?? 0.22;
  const whiteAbove = opts.whiteAbove ?? 0.72;
  const hsv = rgbToHsv(r, g, b);
  const wants = (c: TokenColor) => !!opts.palette?.includes(c);

  if (hsv.v < blackBelow) {
    return wants("black") ? { color: "black", confidence: 1 - hsv.v / blackBelow, hsv } : null;
  }
  if (hsv.s < minSaturation) {
    const color: TokenColor = hsv.v > whiteAbove ? "white" : "grey";
    return wants(color) ? { color, confidence: 1 - hsv.s / minSaturation, hsv } : null;
  }

  const allowed = opts.palette
    ? HUES.filter((c) => opts.palette!.includes(c.color))
    : HUES;
  // A palette of nothing but achromatic colours has no hue to match against.
  if (!allowed.length) return null;
  const candidates = allowed;

  let best = candidates[0];
  let bestD = 360;
  let secondD = 360;
  for (const c of candidates) {
    const d = hueDistance(hsv.h, c.hue);
    if (d < bestD) {
      secondD = bestD;
      bestD = d;
      best = c;
    } else if (d < secondD) {
      secondD = d;
    }
  }

  // Confidence is the margin to the runner-up, not the absolute distance: a
  // sample sitting exactly between orange and yellow is the uncertain case,
  // and a game can require a margin before acting on it.
  const margin = candidates.length > 1 ? (secondD - bestD) / (secondD + bestD || 1) : 1;
  return { color: best.color, confidence: Math.max(0, Math.min(1, margin)), hsv };
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Display colour for each bucket, used by game UI and the debug overlay. */
export const COLOR_SWATCH: Record<TokenColor, string> = {
  red: "#e23b3b",
  orange: "#f08a24",
  yellow: "#f2ce27",
  green: "#39b54a",
  cyan: "#28c3d4",
  blue: "#3a72e8",
  purple: "#8a55d6",
  pink: "#e558a8",
  white: "#f4f4f4",
  grey: "#8d8d94",
  black: "#26262b",
};
