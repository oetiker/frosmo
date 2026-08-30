/**
 * Printable pieces.
 *
 * Nobody should have to buy anything to try this. A sheet of paper, scissors
 * and five minutes gives a full set of letter tiles and colour tokens.
 *
 * The letter tiles are set in the typeface the recogniser was trained on, so
 * tiles printed here are the letterforms it knows best — recognition of these
 * is as good as this pipeline gets, and everything else (Osmo's own tiles,
 * Scrabble, handwriting) degrades from there.
 *
 * The border is deliberately a quarter the weight of a glyph stroke. It is a
 * cut line, but the camera sees it too, and once it is broken into fragments by
 * the mask it is glyph-sized and glyph-shaped; weight is the one cue that still
 * separates it from a letter, so it is worth keeping the difference wide.
 */

import { SWATCHES } from "../../vision/card.js";
import { DEFAULT_DIGITS, DEFAULT_LETTERS, GLYPH_FONT_STACK } from "../../vision/glyph.js";
import { h, s } from "../../util/dom.js";
import type { App, Screen } from "../app.js";

/*
 * The token inks, taken from the calibration card rather than repeated here.
 *
 * They were two lists until now, and the two had drifted: the card's red was
 * #d7263d and the printed token's #d93025. That is not a cosmetic difference —
 * the card exists to tell the app what these inks look like through this
 * camera, and a swatch of a colour nobody prints tells it nothing.
 */
const TOKEN_COLORS = SWATCHES.map((s) => [s.name[0].toUpperCase() + s.name.slice(1), s.css]);

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
              "There is also a ",
              h("a", { href: "#/card", onclick: (e: Event) => { e.preventDefault(); app.go("card"); } }, "calibration card"),
              " — one sheet that sets up the camera for your rig, so nothing has to be tuned by hand.",
            ),
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
                "p",
                { class: "no-print note" },
                "Tokens are sorted by hue, so they have to come off a colour printer — a greyscale copy of the sheet gives four discs the camera cannot tell apart.",
              ),
              h(
                "div",
                { class: "tokens" },
                ...TOKEN_COLORS.flatMap(([name, colour]) =>
                  Array.from({ length: 6 }, () => token(name, colour)),
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

/**
 * A token is drawn rather than styled.
 *
 * A `background` here is what the first attempt used, and it prints blank:
 * browsers treat background colours as decoration and leave them out of a
 * print job unless the user finds the "background graphics" checkbox. An SVG
 * fill is content, so it comes out of every printer without the user having to
 * know that.
 */
function token(name: string, colour: string): SVGSVGElement {
  return s(
    "svg",
    { class: "token", viewBox: "0 0 100 100", role: "img", "aria-label": `${name} token` },
    s("title", {}, `${name} token`),
    s("circle", {
      cx: 50,
      cy: 50,
      r: 48.9,
      fill: colour,
      stroke: "#111",
      "stroke-opacity": 0.53,
      "stroke-width": 2.2,
    }),
  );
}
