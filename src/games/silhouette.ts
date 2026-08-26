/**
 * Silhouette — cover the shape with real things.
 *
 * A shape appears on screen; the player fills it using whatever is to hand,
 * tangram pieces or bread crusts. Scoring compares two masks: how much of the
 * target is covered, less how much spills outside it. Nothing has to be
 * identified, so this is the most forgiving game here and the right one to try
 * first after calibrating.
 */

import { fillPolygons, fitPolygons, type Polygon } from "../engine/raster.js";
import { coverage, createMask, spill, type Mask } from "../vision/mask.js";
import {
  toScreenX,
  toScreenY,
  type BoardUnits,
  type GameDef,
  type GameEnv,
  type GameHud,
  type GameInstance,
} from "./types.js";

interface Shape {
  name: string;
  polygons: Polygon[];
}

/** Unit-square outlines; fitPolygons scales them to the calibrated board. */
const SHAPES: Shape[] = [
  { name: "House", polygons: [[0.5, 0, 1, 0.4, 0.85, 0.4, 0.85, 1, 0.15, 1, 0.15, 0.4, 0, 0.4]] },
  { name: "Arrow", polygons: [[0.5, 0, 1, 0.5, 0.72, 0.5, 0.72, 1, 0.28, 1, 0.28, 0.5, 0, 0.5]] },
  { name: "Boat", polygons: [[0.5, 0, 0.56, 0.6, 1, 0.6, 0.82, 1, 0.18, 1, 0, 0.6, 0.44, 0.6]] },
  { name: "Cross", polygons: [[0.35, 0, 0.65, 0, 0.65, 0.35, 1, 0.35, 1, 0.65, 0.65, 0.65, 0.65, 1, 0.35, 1, 0.35, 0.65, 0, 0.65, 0, 0.35, 0.35, 0.35]] },
  { name: "Heart", polygons: [[0.5, 0.18, 0.72, 0, 0.95, 0.12, 1, 0.42, 0.5, 1, 0, 0.42, 0.05, 0.12, 0.28, 0]] },
  { name: "Star", polygons: [starPolygon()] },
];

function starPolygon(): Polygon {
  const pts: Polygon = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 === 0 ? 0.5 : 0.21;
    pts.push(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r);
  }
  return pts;
}

const NEEDED_COVERAGE = 0.78;
const ALLOWED_SPILL = 0.3;
const HOLD_SECONDS = 0.8;

class Silhouette implements GameInstance {
  private target: Mask | null = null;
  private polygons: Polygon[] = [];
  private index = 0;
  private score = 0;
  private held = 0;
  private lastCoverage = 0;
  private lastSpill = 0;
  private solved = false;
  private celebrate = 0;

  constructor(private readonly board: BoardUnits) {}

  reset(): void {
    this.index = 0;
    this.score = 0;
    this.held = 0;
    this.solved = false;
    this.target = null;
  }

  private ensureTarget(env: GameEnv): Mask {
    const { w, h } = env.vision.board;
    if (!this.target || this.target.w !== w || this.target.h !== h || this.polygons.length === 0) {
      this.target = createMask(w, h);
      this.polygons = fitPolygons(SHAPES[this.index].polygons, this.board.w, this.board.h);
      fillPolygons(this.target, this.polygons, this.board.w / w);
    }
    return this.target;
  }

  update(env: GameEnv): void {
    const target = this.ensureTarget(env);
    this.celebrate = Math.max(0, this.celebrate - env.dt * 1.5);

    if (this.solved) {
      if (env.taps.length) this.next(env);
      return;
    }

    this.lastCoverage = coverage(target, env.vision.occupancy);
    this.lastSpill = spill(target, env.vision.occupancy);

    const good = this.lastCoverage >= NEEDED_COVERAGE && this.lastSpill <= ALLOWED_SPILL;
    if (good) {
      // Held rather than instantaneous: a hand sweeping across the shape
      // covers it perfectly for one frame, and rewarding that teaches the
      // wrong thing.
      this.held += env.dt;
      if (this.held >= HOLD_SECONDS) this.succeed(env);
    } else {
      this.held = Math.max(0, this.held - env.dt * 2);
    }
  }

  private succeed(env: GameEnv): void {
    this.solved = true;
    this.celebrate = 1;
    this.score += Math.round(100 * this.lastCoverage * (1 - this.lastSpill));
    env.audio.play("great");
  }

  private next(env: GameEnv): void {
    this.index = (this.index + 1) % SHAPES.length;
    this.solved = false;
    this.held = 0;
    this.target = null;
    this.polygons = [];
    env.audio.play("blip");
  }

  hud(): GameHud {
    if (this.solved) {
      return {
        score: this.score,
        message: `${SHAPES[this.index].name}!`,
        detail: "Tap for the next shape",
        progress: 1,
      };
    }
    const detail =
      this.lastSpill > ALLOWED_SPILL
        ? "Too much outside the outline"
        : `Fill the ${SHAPES[this.index].name.toLowerCase()}`;
    return {
      score: this.score,
      message: this.held > 0 ? "Hold it…" : "",
      detail,
      progress: this.lastCoverage,
    };
  }

  render(env: GameEnv): void {
    const { ctx, layout } = env;
    const sx = (v: number) => toScreenX(layout, v);
    const sy = (v: number) => toScreenY(layout, v);

    // Target outline
    ctx.save();
    ctx.beginPath();
    for (const poly of this.polygons) {
      ctx.moveTo(sx(poly[0]), sy(poly[1]));
      for (let i = 2; i < poly.length; i += 2) ctx.lineTo(sx(poly[i]), sy(poly[i + 1]));
      ctx.closePath();
    }
    ctx.fillStyle = this.solved ? `rgba(87, 200, 120, ${0.35 + this.celebrate * 0.4})` : "rgba(120, 150, 220, 0.22)";
    ctx.fill();
    ctx.strokeStyle = this.solved ? "#57c878" : "#7d9fe8";
    ctx.lineWidth = Math.max(2, layout.scale * 0.012);
    ctx.setLineDash(this.solved ? [] : [layout.scale * 0.03, layout.scale * 0.02]);
    ctx.stroke();
    ctx.restore();

    // What the camera sees, clipped into and out of the target so the player
    // can see at a glance which parts count and which spill over.
    drawMask(env, env.vision.occupancy, "rgba(240, 244, 255, 0.55)");
  }
}

/**
 * Blit a mask at board resolution into the layout rect.
 *
 * Through an offscreen buffer and one scaled drawImage, rather than a rectangle
 * per covered run. Drawing runs directly looked like a barcode: consecutive
 * rows have to overlap slightly to avoid seams, and overlapping translucent
 * fills composite twice, which reads as horizontal banding across every piece.
 * One blit has no seams, composites once, and is a single GPU operation.
 */
const maskBuffers = new WeakMap<Mask, { canvas: HTMLCanvasElement; rgba: Uint8ClampedArray }>();

export function drawMask(env: GameEnv, mask: Mask, style: string): void {
  const { ctx, layout } = env;
  let buf = maskBuffers.get(mask);
  if (!buf || buf.canvas.width !== mask.w || buf.canvas.height !== mask.h) {
    const canvas = document.createElement("canvas");
    canvas.width = mask.w;
    canvas.height = mask.h;
    buf = { canvas, rgba: new Uint8ClampedArray(mask.w * mask.h * 4) };
    maskBuffers.set(mask, buf);
  }

  const [r, g, b, a] = parseStyle(style);
  const { rgba } = buf;
  for (let i = 0; i < mask.data.length; i++) {
    const o = i * 4;
    const on = mask.data[i];
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = on ? a : 0;
  }

  const bctx = buf.canvas.getContext("2d")!;
  const img = bctx.createImageData(mask.w, mask.h);
  img.data.set(rgba);
  bctx.putImageData(img, 0, 0);

  // Nearest-neighbour: a smoothed mask edge looks like fog rather than like a
  // piece with a boundary, and players read the boundary.
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buf.canvas, layout.x, layout.y, layout.w, layout.h);
  ctx.imageSmoothingEnabled = smoothing;
}

/** Accepts "#rrggbb" and "rgba(r, g, b, a)" — the two forms the games use. */
function parseStyle(style: string): [number, number, number, number] {
  const rgba = style.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(",").map((v) => Number(v.trim()));
    return [parts[0], parts[1], parts[2], Math.round((parts[3] ?? 1) * 255)];
  }
  const hex = style.replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    255,
  ];
}

export const silhouette: GameDef = {
  id: "silhouette",
  title: "Silhouette",
  tagline: "Fill the shape with anything you have",
  emoji: "🧩",
  needs: { occupancy: true },
  materials: ["Tangram pieces, blocks, coins, biscuits — anything opaque"],
  how: [
    "A shape appears on screen.",
    "Cover it on the table until the outline fills up.",
    "Keep inside the lines: spilling over costs points.",
  ],
  create: (board) => new Silhouette(board),
};
