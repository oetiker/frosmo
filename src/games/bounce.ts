/**
 * Bounce — build a run out of whatever is on the table.
 *
 * Balls fall from a spout at the top of the play area and have to reach a lit
 * cup at the bottom. Everything the camera sees is solid: wooden blocks, a
 * pencil case, lines drawn on paper, a hand held flat. The game never asks what
 * an obstacle *is*, only where it is, which is why it works with a toy box
 * nobody designed for it.
 */

import { stepBall, type Ball } from "../engine/physics.js";
import {
  toScreenX,
  toScreenY,
  type BoardUnits,
  type GameDef,
  type GameEnv,
  type GameHud,
  type GameInstance,
} from "./types.js";

const ROUND_SECONDS = 100;
const SPAWN_INTERVAL = 2.6;
const CUP_COLORS = ["#e23b3b", "#f2a527", "#39b54a", "#3a72e8"];

interface Cup {
  x: number;
  w: number;
  color: string;
}

class Bounce implements GameInstance {
  private balls: Ball[] = [];
  private cups: Cup[] = [];
  private target = 0;
  private score = 0;
  private landed = 0;
  private sinceSpawn = SPAWN_INTERVAL;
  private timeLeft = ROUND_SECONDS;
  private spoutX = 0.5;
  private flash = 0;
  private note = "";

  constructor(private readonly board: BoardUnits) {
    this.layoutCups();
  }

  reset(): void {
    this.balls = [];
    this.score = 0;
    this.landed = 0;
    this.timeLeft = ROUND_SECONDS;
    this.sinceSpawn = SPAWN_INTERVAL;
    this.target = 0;
    this.note = "";
    this.layoutCups();
  }

  private layoutCups(): void {
    const n = CUP_COLORS.length;
    const gap = 0.02;
    const w = (1 - gap * (n + 1)) / n;
    this.cups = CUP_COLORS.map((color, i) => ({ x: gap + i * (w + gap), w, color }));
  }

  update(env: GameEnv): void {
    if (this.timeLeft <= 0) return;

    this.timeLeft = Math.max(0, this.timeLeft - env.dt);
    this.flash = Math.max(0, this.flash - env.dt * 2);

    // Tapping the screen drops a ball immediately: waiting out the timer while
    // a child holds a ramp in place is the fastest way to lose them.
    for (const tap of env.taps) {
      this.spoutX = Math.min(0.9, Math.max(0.1, tap.x));
      this.spawn(env);
    }

    this.sinceSpawn += env.dt;
    if (this.sinceSpawn >= SPAWN_INTERVAL) this.spawn(env);

    const field = { data: env.vision.field, w: env.vision.board.w, h: env.vision.board.h };

    for (const ball of this.balls) {
      if (ball.dead) continue;
      const wasY = ball.y;
      stepBall(ball, field, this.board.w, this.board.h, env.dt, {
        gravity: 0.75,
        restitution: 0.5,
        friction: 0.14,
      });

      // A cup catches at its mouth, not at the floor, so a ball skimming the
      // rim still counts and the player is never told "so close" by a pixel.
      if (wasY < this.cupMouth() && ball.y >= this.cupMouth()) {
        const hit = this.cups.findIndex((c) => ball.x >= c.x && ball.x <= c.x + c.w);
        if (hit >= 0) this.land(hit, env);
      }
    }

    this.balls = this.balls.filter((b) => !b.dead);
  }

  private cupMouth(): number {
    return this.board.h - 0.1;
  }

  private spawn(env: GameEnv): void {
    this.sinceSpawn = 0;
    if (this.balls.length > 12) return;
    this.balls.push({
      x: this.spoutX,
      y: 0.04,
      // A touch of sideways drift so two balls never trace the same path and
      // the run has to work, not just work once.
      vx: (Math.random() - 0.5) * 0.06,
      vy: 0.05,
      r: 0.022,
      dead: false,
    });
    env.audio.play("drop");
  }

  private land(cup: number, env: GameEnv): void {
    this.landed++;
    if (cup === this.target) {
      this.score += 10;
      this.note = "Yes!";
      this.flash = 1;
      env.audio.play("great");
      this.target = (this.target + 1 + Math.floor(Math.random() * 3)) % this.cups.length;
    } else {
      this.score += 2;
      this.note = "Close";
      env.audio.play("good");
    }
  }

  hud(): GameHud {
    if (this.timeLeft <= 0) {
      return {
        score: this.score,
        message: "Time!",
        detail: `${this.landed} ball${this.landed === 1 ? "" : "s"} caught — tap to play again`,
      };
    }
    return {
      score: this.score,
      message: this.note,
      detail: "Build a run to the lit cup — tap to drop a ball",
      timeLeft: this.timeLeft,
    };
  }

  render(env: GameEnv): void {
    const { ctx, layout } = env;
    const sx = (v: number) => toScreenX(layout, v);
    const sy = (v: number) => toScreenY(layout, v);

    drawTable(env);

    // Spout
    ctx.fillStyle = "#f0f1f6";
    ctx.fillRect(sx(this.spoutX) - layout.scale * 0.05, layout.y, layout.scale * 0.1, layout.scale * 0.02);

    // Cups
    const mouth = sy(this.cupMouth());
    const depth = layout.scale * 0.09;
    this.cups.forEach((cup, i) => {
      const lit = i === this.target;
      ctx.globalAlpha = lit ? 1 : 0.35;
      ctx.fillStyle = cup.color;
      ctx.beginPath();
      ctx.moveTo(sx(cup.x), mouth);
      ctx.lineTo(sx(cup.x + cup.w), mouth);
      ctx.lineTo(sx(cup.x + cup.w * 0.86), mouth + depth);
      ctx.lineTo(sx(cup.x + cup.w * 0.14), mouth + depth);
      ctx.closePath();
      ctx.fill();
      if (lit) {
        ctx.globalAlpha = 0.25 + this.flash * 0.5;
        ctx.fillRect(sx(cup.x), layout.y, cup.w * layout.scale, mouth - layout.y);
      }
      ctx.globalAlpha = 1;
    });

    // Balls
    for (const ball of this.balls) {
      const r = ball.r * layout.scale;
      const g = ctx.createRadialGradient(
        sx(ball.x) - r * 0.3,
        sy(ball.y) - r * 0.3,
        r * 0.1,
        sx(ball.x),
        sy(ball.y),
        r,
      );
      g.addColorStop(0, "#fff");
      g.addColorStop(1, "#f6c344");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx(ball.x), sy(ball.y), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Draw what the camera sees, as filled outlines.
 *
 * This is the game's most important feedback: a player who cannot see their
 * ramp on screen has no way to tell a badly placed block from a badly
 * calibrated board. Contours rather than the raw mask, so a pencil line stays a
 * crisp line at Retina resolution instead of a row of grey squares.
 */
export function drawTable(env: GameEnv, style = "#2f3a52"): void {
  const { ctx, layout, vision } = env;
  const k = layout.scale / vision.board.w;
  ctx.fillStyle = style;
  ctx.beginPath();
  for (const c of vision.contours) {
    if (c.length < 6) continue;
    ctx.moveTo(layout.x + c[0] * k, layout.y + c[1] * k);
    for (let i = 2; i < c.length; i += 2) {
      ctx.lineTo(layout.x + c[i] * k, layout.y + c[i + 1] * k);
    }
    ctx.closePath();
  }
  ctx.fill();
}

export const bounce: GameDef = {
  id: "bounce",
  title: "Bounce",
  tagline: "Build a run out of anything on the table",
  emoji: "🎳",
  needs: { occupancy: true, ink: true, field: true, contours: true },
  materials: [
    "Blocks, boxes, pencils — anything solid",
    "Or a sheet of paper and a thick pen",
  ],
  how: [
    "Balls fall from the top of the play area.",
    "Arrange things on the table to steer them into the lit cup.",
    "Tap the screen to drop a ball where you tapped.",
  ],
  create: (board) => new Bounce(board),
};
