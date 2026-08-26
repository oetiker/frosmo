/**
 * The contract between the vision pipeline and a game.
 *
 * Games are deliberately small: they receive a stabilised view of the table and
 * a canvas, and own nothing else. No game touches the camera, the calibration,
 * the service worker or the DOM. Adding a game means adding one file and one
 * line to the registry.
 *
 * Board units, not pixels: the play area is 1 wide and `board.h` tall, so a
 * game plays identically on a sheet of A4 and on a kitchen table, and the same
 * code drives a 264ppi iPad and a debug window on a laptop.
 */

import { letterbox } from "../util/layout.js";
import type { Audio } from "../util/audio.js";
import type { VisionNeeds, VisionState } from "../vision/pipeline.js";

export interface BoardUnits {
  /** Always 1. Named so the maths below reads honestly. */
  w: number;
  /** Height in the same units: 1 / aspect. */
  h: number;
}

export interface Layout {
  /** Where the board sits on the canvas, in CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Canvas pixels per board unit. */
  scale: number;
}

export interface GameEnv {
  ctx: CanvasRenderingContext2D;
  layout: Layout;
  board: BoardUnits;
  vision: VisionState;
  /** Seconds since the previous frame, clamped so a backgrounded tab cannot teleport the game. */
  dt: number;
  /** Seconds since the game started. */
  time: number;
  audio: Audio;
  /** Screen taps since the last frame, in board units. */
  taps: Array<{ x: number; y: number }>;
}

export interface GameHud {
  score?: number;
  /** Large centred line — what to do now. */
  message?: string;
  /** Smaller supporting line. */
  detail?: string;
  /** 0-1, drawn as a bar. */
  progress?: number;
  /** Seconds remaining, when the game is timed. */
  timeLeft?: number;
}

export interface GameInstance {
  update(env: GameEnv): void;
  render(env: GameEnv): void;
  hud(): GameHud;
  reset(): void;
}

export interface GameDef {
  id: string;
  title: string;
  tagline: string;
  emoji: string;
  /** Which detectors this game needs; anything unlisted is never computed. */
  needs: VisionNeeds;
  /** What to put on the table. Shown before play starts. */
  materials: string[];
  /** How to play, two or three short lines. */
  how: string[];
  create(board: BoardUnits): GameInstance;
}

/** Letterbox the board into the canvas, preserving the play area's aspect. */
export function computeLayout(canvasW: number, canvasH: number, board: BoardUnits): Layout {
  const rect = letterbox(canvasW, canvasH, board.w / board.h);
  return { ...rect, scale: rect.w / board.w };
}

export function toScreenX(layout: Layout, bx: number): number {
  return layout.x + bx * layout.scale;
}

export function toScreenY(layout: Layout, by: number): number {
  return layout.y + by * layout.scale;
}

/** Board pixels (the vision buffers' index space) to board units. */
export function pxToUnits(vision: VisionState, px: number): number {
  return px / vision.board.w;
}
