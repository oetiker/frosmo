/**
 * Printable pieces.
 *
 * Nobody should have to buy anything to try this. A sheet of paper, scissors
 * and five minutes gives a full set of letter tiles and colour tokens.
 *
 * The letter tiles are set in the same typeface the glyph atlas is rendered in,
 * so tiles printed here are matched against templates with identical
 * letterforms — recognition of these is as good as this pipeline gets, and
 * everything else (Osmo's own tiles, Scrabble, handwriting) degrades from
 * there.
 */

import { DEFAULT_DIGITS, DEFAULT_LETTERS, GLYPH_FONT_STACK } from "../../vision/glyph.js";
import { h } from "../../util/dom.js";
import type { App, Screen } from "../app.js";

const TOKEN_COLORS = [
  ["Red", "#d93025"],
  ["Yellow", "#f2b705"],
  ["Green", "#1e9e4a"],
  ["Blue", "#1a63d8"],
];

export function printScreen(): Screen {
  return {
    mount(app: App, root: HTMLElement) {
      root.append(
        h(
          "div",
          { class: "screen print" },
          h(
            "header",
            { class: "topbar no-print" },
            h("button", { class: "chip", onclick: () => app.go("home") }, "‹ Back"),
            h("div", { class: "title" }, "Print your pieces"),
            h(
              "div",
              { class: "topbar-actions" },
              h("button", { class: "primary", onclick: () => window.print() }, "Print"),
            ),
          ),
          h(
            "div",
            { class: "scroll" },
            h(
              "p",
              { class: "no-print note" },
              "Print at 100% scale on plain paper, then cut along the lines. Card stock or a glue stick onto cereal box works better than paper alone — floppy tiles curl and cast shadows the camera reads as marks.",
            ),
            h(
              "section",
              { class: "sheet" },
              h("h2", {}, "Letter tiles"),
              h(
                "div",
                { class: "tiles" },
                ...[...DEFAULT_LETTERS].map(tile),
                ...[...DEFAULT_DIGITS].map(tile),
              ),
            ),
            h(
              "section",
              { class: "sheet" },
              h("h2", {}, "Colour tokens"),
              h(
                "div",
                { class: "tokens" },
                ...TOKEN_COLORS.flatMap(([name, colour]) =>
                  Array.from({ length: 6 }, () =>
                    h("div", { class: "token", style: `background:${colour}`, title: name }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    },
  };
}

function tile(ch: string): HTMLElement {
  return h("div", { class: "tile", style: `font-family:${GLYPH_FONT_STACK}` }, ch);
}
