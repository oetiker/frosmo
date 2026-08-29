/**
 * Spell It — lay out letter tiles to make the word.
 *
 * The one game here that depends on recognising *what* a piece is rather than
 * where it is, so it is also the one with the most care taken over being wrong:
 * only tiles the matcher is confident about and that have held still for
 * several frames are read at all, and the letters it thinks it sees are always
 * shown, so a misread looks like a misread rather than like the game ignoring
 * you.
 */

import { DEFAULT_LETTERS } from "../vision/glyph.js";
import { Stabiliser } from "../vision/stability.js";
import type { GameDef, GameEnv, GameHud, GameInstance } from "./types.js";

interface Word {
  word: string;
  hint: string;
}

/** Short, concrete, and spellable from one set of tiles. */
const WORDS: Word[] = [
  { word: "CAT", hint: "🐈" },
  { word: "SUN", hint: "☀️" },
  { word: "DOG", hint: "🐕" },
  { word: "BOAT", hint: "⛵" },
  { word: "STAR", hint: "⭐" },
  { word: "FISH", hint: "🐟" },
  { word: "TREE", hint: "🌳" },
  { word: "MOON", hint: "🌙" },
  { word: "CAKE", hint: "🍰" },
  { word: "TRAIN", hint: "🚂" },
];

const HOLD_SECONDS = 0.9;
/** Tiles below this margin over the runner-up are shown as uncertain, never read. */
const MIN_MARGIN = 0.1;

class Spell implements GameInstance {
  private readonly tracker = new Stabiliser<string>({
    promoteAfter: 6,
    forgetAfter: 10,
    radius: 26,
  });
  private order: number[] = [];
  private index = 0;
  private score = 0;
  private held = 0;
  private solved = false;
  private reading = "";
  private uncertain = 0;

  constructor() {
    this.shuffle();
  }

  reset(): void {
    this.tracker.reset();
    this.score = 0;
    this.index = 0;
    this.held = 0;
    this.solved = false;
    this.shuffle();
  }

  private shuffle(): void {
    this.order = WORDS.map((_, i) => i).sort(() => Math.random() - 0.5);
  }

  private get target(): Word {
    return WORDS[this.order[this.index % this.order.length]];
  }

  update(env: GameEnv): void {
    const confident = env.vision.tiles.filter((t) => t.margin >= MIN_MARGIN);
    this.uncertain = env.vision.tiles.length - confident.length;

    this.tracker.update(
      confident.map((t) => ({ key: t.char, x: t.cx, y: t.cy, value: t.char })),
    );

    // Reading order is left to right across the play area. Rows are not
    // handled on purpose: one word, one line, which is also how the tiles fit
    // in front of an iPad.
    this.reading = this.tracker
      .stable()
      .sort((a, b) => a.x - b.x)
      .map((t) => t.value)
      .join("");

    if (this.solved) {
      if (env.taps.length || this.reading !== this.target.word) this.next(env);
      return;
    }

    if (this.reading === this.target.word) {
      this.held += env.dt;
      if (this.held >= HOLD_SECONDS) {
        this.solved = true;
        this.score += 10 * this.target.word.length;
        env.audio.play("great");
      }
    } else {
      this.held = Math.max(0, this.held - env.dt * 2);
    }
  }

  private next(env: GameEnv): void {
    this.index++;
    this.solved = false;
    this.held = 0;
    env.audio.play("blip");
  }

  hud(): GameHud {
    if (this.solved) {
      return { score: this.score, message: `${this.target.word}!`, detail: "Clear the tiles for the next word", progress: 1 };
    }
    const detail = this.uncertain
      ? `${this.uncertain} tile${this.uncertain === 1 ? "" : "s"} unclear — straighten them up`
      : "Spell it with your tiles";
    return {
      score: this.score,
      message: this.target.hint,
      detail,
      progress: this.held / HOLD_SECONDS,
    };
  }

  render(env: GameEnv): void {
    const { ctx, layout } = env;
    const word = this.target.word;

    // Slots: one per letter, filled as the reading matches.
    const slotW = Math.min(layout.w / (word.length + 1), layout.scale * 0.16);
    const gap = slotW * 0.18;
    const totalW = word.length * slotW + (word.length - 1) * gap;
    const x0 = layout.x + (layout.w - totalW) / 2;
    const y = layout.y + layout.h * 0.16;

    for (let i = 0; i < word.length; i++) {
      const got = this.reading[i];
      const right = got === word[i];
      const x = x0 + i * (slotW + gap);

      ctx.fillStyle = right ? "rgba(87, 200, 120, 0.9)" : "rgba(255,255,255,0.09)";
      roundRect(ctx, x, y, slotW, slotW * 1.2, slotW * 0.16);
      ctx.fill();

      ctx.fillStyle = right ? "#0d1220" : "rgba(255,255,255,0.35)";
      ctx.font = `700 ${slotW * 0.7}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Show the letter once it is right, and a placeholder otherwise: showing
      // the answer would make the game a copying exercise.
      ctx.fillText(right ? word[i] : "?", x + slotW / 2, y + slotW * 0.62);
    }

    // Every tile the camera thinks it can read, where it lies.
    const k = layout.scale / env.vision.board.w;
    for (const tile of env.vision.tiles) {
      const cx = layout.x + tile.cx * k;
      const cy = layout.y + tile.cy * k;
      const size = Math.max(18, tile.size * k);
      const sure = tile.margin >= MIN_MARGIN;

      ctx.strokeStyle = sure ? "rgba(125, 159, 232, 0.9)" : "rgba(230, 160, 90, 0.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash(sure ? [] : [5, 4]);
      ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
      ctx.setLineDash([]);

      ctx.fillStyle = sure ? "rgba(125, 159, 232, 0.95)" : "rgba(230, 160, 90, 0.9)";
      ctx.font = `700 ${size * 0.5}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tile.char, cx, cy);
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const spell: GameDef = {
  id: "spell",
  title: "Spell It",
  tagline: "Lay out tiles to make the word",
  emoji: "🔤",
  // Letters only. Competing against the digits as well cost this game a D
  // (read as 0) and an A (read as 4) on a real sheet.
  needs: { occupancy: true, tiles: true, alphabet: DEFAULT_LETTERS },
  materials: [
    "Letter tiles — Osmo Words, Scrabble, or the sheet this app prints",
    "Lay them in one row, right way up",
  ],
  how: [
    "A picture appears; spell what it shows.",
    "Put the tiles in a row in the play area, left to right.",
    "Slots turn green as each letter is read correctly.",
  ],
  create: () => new Spell(),
};
