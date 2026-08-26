/**
 * Every game the app knows about.
 *
 * Adding a game is one import and one array entry — no routing, no menu markup,
 * no service-worker change.
 */

import { bounce } from "./bounce.js";
import { colorRush } from "./colorrush.js";
import { silhouette } from "./silhouette.js";
import { spell } from "./spell.js";
import type { GameDef } from "./types.js";

export const GAMES: GameDef[] = [silhouette, bounce, colorRush, spell];

export function findGame(id: string): GameDef | undefined {
  return GAMES.find((g) => g.id === id);
}
