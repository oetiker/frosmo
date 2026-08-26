/** The menu: pick a game, or go and fix the rig. */

import type { GameDef } from "../../games/types.js";
import { h } from "../../util/dom.js";
import type { App, Screen } from "../app.js";

export function homeScreen(): Screen {
  return {
    mount(app: App, root: HTMLElement) {
      const calibrated = Boolean(app.calibration);

      root.append(
        h(
          "div",
          { class: "screen home" },
          h(
            "header",
            { class: "topbar" },
            h("div", { class: "brand" }, h("span", { class: "logo" }, "◳"), h("span", {}, "frosmo")),
            h(
              "div",
              { class: "topbar-actions" },
              h(
                "button",
                { class: "chip", onclick: () => app.go("calibrate") },
                calibrated ? "Board set up ✓" : "Set up the board",
              ),
            ),
          ),
          h(
            "div",
            { class: "scroll" },
            !calibrated &&
              h(
                "div",
                { class: "notice" },
                h("strong", {}, "Set the board up first. "),
                "Mark the four corners of the play area so the camera knows where the table is.",
              ),
            h("div", { class: "grid" }, ...app.games.map((game) => card(app, game, calibrated))),
            h(
              "div",
              { class: "row" },
              h("button", { class: "ghost", onclick: () => app.go("lab") }, "Vision lab"),
              h("button", { class: "ghost", onclick: () => app.go("print") }, "Print tiles"),
              h("button", { class: "ghost", onclick: () => app.go("about") }, "About"),
            ),
          ),
        ),
      );
    },
  };
}

function card(app: App, game: GameDef, enabled: boolean): HTMLElement {
  return h(
    "button",
    {
      class: `card${enabled ? "" : " disabled"}`,
      onclick: () => {
        app.audio.unlock();
        app.go(enabled ? "play" : "calibrate", enabled ? game.id : undefined);
      },
    },
    h("div", { class: "card-emoji" }, game.emoji),
    h("div", { class: "card-title" }, game.title),
    h("div", { class: "card-tagline" }, game.tagline),
    h(
      "div",
      { class: "card-materials" },
      ...game.materials.map((m) => h("span", { class: "pill" }, m)),
    ),
  );
}
