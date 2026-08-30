/**
 * The printable calibration card.
 *
 * Drawn entirely from `vision/card.ts`, in millimetres — the SVG's user units
 * *are* millimetres, so a stroke the layout calls 0.4 mm is written as 0.4 and
 * comes out of the printer at 0.4. That removes the one place this file could
 * have disagreed with the detector: there is no scale factor to get wrong.
 *
 * Everything on it is either a mark the detector looks for or a note for the
 * person holding it. Nothing decorative: an unexpected dark shape on the card
 * is another ring candidate, and the finder has to reject it.
 */

import {
  CARD_ASPECT, CARD_WIDTH_MM, EDGE, FIDUCIALS, FIDUCIAL_INNER, FIDUCIAL_OUTER, KEY,
  RULES, SWATCHES, TILE, TILE_BORDER_MM, WEDGE, type Patch,
} from "../../vision/card.js";
import { GLYPH_FONT_STACK } from "../../vision/glyph.js";
import { h, s } from "../../util/dom.js";
import type { App, Screen } from "../app.js";

const W = CARD_WIDTH_MM;
const H = CARD_WIDTH_MM / CARD_ASPECT;
/** Ring radii are fractions of the card's short side. */
const SHORT = H;

/** A patch's rectangle in millimetres. */
const mm = (p: Patch) => ({ x: p.x * W, y: p.y * H, w: p.w * W, h: p.h * H });

export function cardScreen(): Screen {
  return {
    mount(app: App, root: HTMLElement) {
      root.append(
        h(
          "div",
          { class: "screen print" },
          h(
            "header",
            { class: "topbar no-print" },
            h("button", { class: "chip", onclick: () => app.go("print") }, "‹ Back"),
            h("div", { class: "title" }, "Calibration card"),
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
              "One sheet of A4, landscape, at 100% scale — not “fit to page”. Check the 100 mm bar with a ruler before you use it; if it is short, the card will tell the app the wrong size for everything.",
            ),
            h(
              "p",
              { class: "no-print note" },
              "Then lay it flat in the middle of the play area, under the mirror, and tap Scan card on the calibrate screen. The rectangle the four rings enclose becomes the play area, so put the card where you want to play.",
            ),
            h("section", { class: "sheet card-sheet" }, card()),
          ),
        ),
      );
    },
  };
}

function card(): SVGSVGElement {
  return s(
    "svg",
    {
      class: "cal-card",
      viewBox: `0 0 ${W} ${H}`,
      width: `${W}mm`,
      height: `${H}mm`,
      role: "img",
      "aria-label": "Calibration card",
    },
    s("title", {}, "Calibration card"),
    s("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff" }),

    ...[...FIDUCIALS, KEY].map((f) => ring(f.cx, f.cy)),

    // The grey wedge. Density 0 is bare paper: nothing is printed, because the
    // brightest thing a printer has is the paper itself. A hairline says where
    // it is; the reader insets a fifth of the patch, so it never sees it.
    ...WEDGE.map(({ patch, density }) => {
      const r = mm(patch);
      const v = Math.round(255 * (1 - density));
      return s("rect", {
        x: r.x, y: r.y, width: r.w, height: r.h,
        fill: `rgb(${v},${v},${v})`,
        ...(density === 0 ? { stroke: "#000", "stroke-width": 0.15 } : {}),
      });
    }),

    // Line pairs. Equal bars and gaps at the printed weight, matching what the
    // reader assumes when it turns their surviving modulation into a threshold.
    ...RULES.flatMap(({ patch, strokeMm }) => bars(patch, strokeMm)),

    tile(),
    slantedEdge(),

    ...SWATCHES.map(({ patch, css }) => {
      const r = mm(patch);
      return s("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: css });
    }),

    ruler(),

    s(
      "text",
      { x: 0.5 * W, y: 0.135 * H, "text-anchor": "middle", "font-size": 7, fill: "#111" },
      "Frosmo calibration card",
    ),
    ...[
      "Print at 100% on A4, landscape. Check the bar below reads 100 mm.",
      "Lay it flat where you want to play, then tap Scan card.",
    ].map((line, i) =>
      s(
        "text",
        { x: 0.10 * W, y: (0.65 + i * 0.04) * H, "font-size": 4.4, fill: "#444" },
        line,
      ),
    ),
  );
}

/**
 * A ring, as one path with an even-odd fill.
 *
 * Two circles rather than a stroked one: a stroke is centred on its path, so
 * its inner and outer radii are the layout's radii give or take half a stroke
 * width, and the detector's fill test is tight enough to notice.
 */
function ring(cx: number, cy: number): SVGElement {
  const x = cx * W;
  const y = cy * H;
  const ro = FIDUCIAL_OUTER * SHORT;
  const ri = FIDUCIAL_INNER * SHORT;
  const circle = (r: number) =>
    `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  return s("path", { d: `${circle(ro)} ${circle(ri)}`, "fill-rule": "evenodd", fill: "#000" });
}

function bars(patch: Patch, strokeMm: number): SVGElement[] {
  const r = mm(patch);
  const out: SVGElement[] = [];
  for (let x = r.x; x + strokeMm <= r.x + r.w; x += strokeMm * 2) {
    out.push(s("rect", { x, y: r.y, width: strokeMm, height: r.h, fill: "#000" }));
  }
  return out;
}

/** A tile of exactly the size, weight and typeface the print screen produces. */
function tile(): SVGElement {
  const r = mm(TILE.patch);
  const side = TILE.sizeMm;
  const x = r.x + (r.w - side) / 2;
  const y = r.y + (r.h - side) / 2;
  return s(
    "g",
    {},
    s("rect", {
      x: x + TILE_BORDER_MM / 2,
      y: y + TILE_BORDER_MM / 2,
      width: side - TILE_BORDER_MM,
      height: side - TILE_BORDER_MM,
      rx: 2,
      fill: "#fff",
      stroke: "#111",
      "stroke-width": TILE_BORDER_MM,
    }),
    s(
      "text",
      {
        x: x + side / 2,
        y: y + side / 2,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "font-family": GLYPH_FONT_STACK,
        "font-weight": 500,
        "font-size": 13,
        fill: "#111",
      },
      TILE.glyph,
    ),
  );
}

function slantedEdge(): SVGElement {
  const r = mm(EDGE.patch);
  const lean = Math.tan((EDGE.degrees * Math.PI) / 180) * r.h;
  const mid = r.x + r.w / 2;
  return s("polygon", {
    points: `${mid},${r.y} ${r.x + r.w},${r.y} ${r.x + r.w},${r.y + r.h} ${mid + lean},${r.y + r.h}`,
    fill: "#000",
  });
}

/**
 * A 100 mm bar, for the reader to check with a ruler.
 *
 * The one thing the card cannot measure about itself. Every other number falls
 * out of proportions, which survive being printed at 94% to fit the margins;
 * absolute size does not, and it is what turns board pixels into millimetres.
 */
function ruler(): SVGElement {
  const x = 0.10 * W;
  const y = 0.80 * H;
  const ticks: SVGElement[] = [];
  for (let i = 0; i <= 10; i++) {
    const tall = i % 5 === 0;
    ticks.push(
      s("rect", { x: x + i * 10 - 0.15, y: y - (tall ? 3 : 1.6), width: 0.3, height: tall ? 3 : 1.6, fill: "#111" }),
    );
  }
  return s(
    "g",
    {},
    s("rect", { x, y, width: 100, height: 0.3, fill: "#111" }),
    ...ticks,
    s("text", { x: x + 50, y: y + 5, "text-anchor": "middle", "font-size": 4, fill: "#444" }, "100 mm"),
  );
}
