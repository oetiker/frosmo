/**
 * Colour Rush — put the right pieces on the table, fast.
 *
 * The screen asks for a handful of coloured tokens; the player supplies them
 * from a pile. Only counts per colour matter, never position, so a four-year-old
 * can play it and the detector never has to be right about *which* red thing it
 * is looking at.
 */

import { COLOR_SWATCH, type TokenColor } from "../vision/color.js";
import { Stabiliser } from "../vision/stability.js";
import type { GameDef, GameEnv, GameHud, GameInstance } from "./types.js";

/**
 * Colours a domestic toy box actually contains, and that survive a camera.
 *
 * Orange rather than yellow, because that is what the printed sheet's amber
 * ink photographs as — measured at 28 degrees on a real iPad, comfortably
 * inside the orange bucket. Asking for "yellow" meant every one of those
 * tokens was classified correctly as orange and then silently discarded for
 * not being on this list.
 */
const PALETTE: TokenColor[] = ["red", "orange", "green", "blue"];
const ROUND_SECONDS = 90;
const HOLD_SECONDS = 0.7;
/** Below this the classifier is sitting between two hues; ignore rather than guess. */
const MIN_CONFIDENCE = 0.12;

type Demand = Partial<Record<TokenColor, number>>;

class ColorRush implements GameInstance {
  private readonly tracker = new Stabiliser<TokenColor>({
    promoteAfter: 5,
    forgetAfter: 8,
    radius: 22,
  });
  private demand: Demand = {};
  private counts: Demand = {};
  private level = 1;
  private score = 0;
  private held = 0;
  private timeLeft = ROUND_SECONDS;
  private solvedAt = -1;
  private note = "";

  constructor() {
    this.newRound();
  }

  reset(): void {
    this.tracker.reset();
    this.level = 1;
    this.score = 0;
    this.held = 0;
    this.timeLeft = ROUND_SECONDS;
    this.solvedAt = -1;
    this.note = "";
    this.newRound();
  }

  private newRound(): void {
    // Two colours at first, up to four, and never more than five tokens: past
    // that it becomes a counting exercise rather than a scramble.
    const colours = Math.min(PALETTE.length, 1 + Math.ceil(this.level / 2));
    const pool = [...PALETTE].sort(() => Math.random() - 0.5).slice(0, colours);
    const total = Math.min(5, 1 + Math.ceil(this.level / 1.5));

    const demand: Demand = {};
    for (let i = 0; i < total; i++) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      demand[c] = (demand[c] ?? 0) + 1;
    }
    this.demand = demand;
    this.held = 0;
  }

  update(env: GameEnv): void {
    if (this.timeLeft <= 0) {
      if (env.taps.length) this.reset();
      return;
    }
    this.timeLeft = Math.max(0, this.timeLeft - env.dt);

    const observations = env.vision.tokens
      .filter((t) => t.confidence >= MIN_CONFIDENCE && PALETTE.includes(t.color))
      .map((t) => ({ key: t.color, x: t.cx, y: t.cy, value: t.color }));
    this.tracker.update(observations);

    const counts: Demand = {};
    for (const t of this.tracker.stable()) counts[t.value] = (counts[t.value] ?? 0) + 1;
    this.counts = counts;

    if (this.matches(counts)) {
      this.held += env.dt;
      if (this.held >= HOLD_SECONDS) this.succeed(env);
    } else {
      this.held = Math.max(0, this.held - env.dt * 1.5);
    }
  }

  private matches(counts: Demand): boolean {
    for (const c of PALETTE) {
      if ((counts[c] ?? 0) !== (this.demand[c] ?? 0)) return false;
    }
    return true;
  }

  private succeed(env: GameEnv): void {
    this.score += 10 * this.level;
    this.level++;
    this.solvedAt = env.time;
    this.note = ["Got it!", "Nice!", "Quick!"][Math.floor(Math.random() * 3)];
    env.audio.play("great");
    this.newRound();
  }

  hud(): GameHud {
    if (this.timeLeft <= 0) {
      return { score: this.score, message: "Time!", detail: "Tap to play again" };
    }
    return {
      score: this.score,
      message: this.note,
      detail: "Put these on the table",
      progress: this.held / HOLD_SECONDS,
      timeLeft: this.timeLeft,
    };
  }

  render(env: GameEnv): void {
    const { ctx, layout } = env;

    // The demand, as chips across the top of the play area.
    const chips: TokenColor[] = [];
    for (const c of PALETTE) for (let i = 0; i < (this.demand[c] ?? 0); i++) chips.push(c);

    const r = layout.scale * 0.055;
    const gap = r * 2.6;
    const startX = layout.x + layout.w / 2 - ((chips.length - 1) * gap) / 2;
    const y = layout.y + r * 2;

    chips.forEach((colour, i) => {
      const supplied = (this.counts[colour] ?? 0) >= countUpTo(chips, colour, i);
      ctx.beginPath();
      ctx.arc(startX + i * gap, y, r, 0, Math.PI * 2);
      ctx.fillStyle = COLOR_SWATCH[colour];
      ctx.globalAlpha = supplied ? 1 : 0.32;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (supplied) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = Math.max(2, r * 0.16);
        ctx.stroke();
      }
    });

    // What the camera found, drawn where it actually is on the table: the
    // player needs to see a token being read as orange when they think it is
    // red, or the game just looks wrong.
    const k = layout.scale / env.vision.board.w;
    for (const t of this.tracker.update([])) {
      if (!t.stable) continue;
      ctx.beginPath();
      ctx.arc(layout.x + t.x * k, layout.y + t.y * k, layout.scale * 0.035, 0, Math.PI * 2);
      ctx.fillStyle = COLOR_SWATCH[t.value];
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.stroke();
    }

    if (this.solvedAt >= 0 && env.time - this.solvedAt < 0.4) {
      ctx.fillStyle = `rgba(87, 200, 120, ${0.35 * (1 - (env.time - this.solvedAt) / 0.4)})`;
      ctx.fillRect(layout.x, layout.y, layout.w, layout.h);
    }
  }
}

/** How many chips of this colour have appeared up to and including index i. */
function countUpTo(chips: TokenColor[], colour: TokenColor, i: number): number {
  let n = 0;
  for (let j = 0; j <= i; j++) if (chips[j] === colour) n++;
  return n;
}

export const colorRush: GameDef = {
  id: "colorrush",
  title: "Colour Rush",
  tagline: "Match the colours before the clock runs out",
  emoji: "🎨",
  needs: { occupancy: true, tokens: true, palette: PALETTE },
  materials: [
    "A pile of coloured things: bricks, bottle caps, counters",
    "Red, orange, green and blue work best",
  ],
  how: [
    "The screen asks for a set of colours.",
    "Put exactly those on the table — no more, no less.",
    "Clear them and go again as fast as you can.",
  ],
  create: () => new ColorRush(),
};
