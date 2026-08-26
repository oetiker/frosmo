/** What this is, what it needs, and what it cannot do. */

import { clearCalibration } from "../../vision/calibration.js";
import { h } from "../../util/dom.js";
import type { App, Screen } from "../app.js";

export function aboutScreen(): Screen {
  return {
    mount(app: App, root: HTMLElement) {
      root.append(
        h(
          "div",
          { class: "screen about" },
          h(
            "header",
            { class: "topbar" },
            h("button", { class: "chip", onclick: () => app.go("home") }, "‹ Back"),
            h("div", { class: "title" }, "About frosmo"),
            h("div", { class: "topbar-actions" }),
          ),
          h(
            "div",
            { class: "scroll prose" },
            h(
              "p",
              {},
              "frosmo plays tabletop games through a mirror clipped over a tablet's front camera — an Osmo base and reflector, or anything that folds the camera's view down onto the table.",
            ),
            h("h3", {}, "It does not know about your rig"),
            h(
              "p",
              {},
              "There is no list of supported iPads and no model of the mirror. Marking the four corners of the play area once tells it everything it needs, which is why it works with hardware nobody tested it against — including a phone propped against a mug.",
            ),
            h("h3", {}, "What it can see"),
            h(
              "ul",
              {},
              h("li", {}, "Anything opaque on the table, as a shape."),
              h("li", {}, "Pen strokes on light paper."),
              h("li", {}, "Coloured pieces, sorted into eight colours."),
              h("li", {}, "Printed letters and digits on tiles."),
            ),
            h("h3", {}, "What it cannot"),
            h(
              "p",
              {},
              "It reads shapes and colours, not objects: it cannot tell a red brick from a red button. Letter recognition needs tiles laid flat, right way up-ish, in one row — and it will say so rather than guess when a tile is ambiguous.",
            ),
            h("h3", {}, "Privacy"),
            h(
              "p",
              {},
              "The camera never leaves the device. There is no account, no server and no analytics; nothing is uploaded, because there is nowhere to upload it to. Scores and your board setup live in this browser's own storage.",
            ),
            h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  class: "ghost",
                  onclick: () => {
                    clearCalibration();
                    app.calibration = null;
                    app.go("calibrate");
                  },
                },
                "Forget board setup",
              ),
            ),
          ),
        ),
      );
    },
  };
}
