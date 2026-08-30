/**
 * Vision lab.
 *
 * Not a game — the instrument for making the games work. Everything interesting
 * about this app only happens under a real mirror, in a real room, with real
 * light, so the pipeline has to be inspectable *on the iPad* rather than in a
 * console on a laptop that cannot see the table at all.
 *
 * It shows each stage's output side by side, the per-stage cost in
 * milliseconds, and what the detectors currently believe is on the table.
 */

import { captureDiagnostics, shareBundle } from "../diagnostics.js";
import { COLOR_SWATCH } from "../../vision/color.js";
import { describeGain } from "../../vision/photometry.js";
import { describeCameraError, onVideoFrame } from "../../vision/camera.js";
import type { Mask } from "../../vision/mask.js";
import type { VisionState } from "../../vision/pipeline.js";
import { h, putRgba } from "../../util/dom.js";
import type { App, Screen } from "../app.js";

export function labScreen(): Screen {
  let stopFrames: (() => void) | null = null;
  let owner: App | null = null;

  return {
    mount(app: App, root: HTMLElement) {
      owner = app;
      const board = app.pipeline.boardSizePx;

      const rectified = h("canvas", { class: "lab-canvas", width: String(board.w), height: String(board.h) });
      const occupancy = h("canvas", { class: "lab-canvas", width: String(board.w), height: String(board.h) });
      const ink = h("canvas", { class: "lab-canvas", width: String(board.w), height: String(board.h) });
      const found = h("canvas", { class: "lab-canvas", width: String(board.w), height: String(board.h) });
      const timings = h("div", { class: "lab-timings" });
      const readout = new Readout();
      const status = h("div", { class: "cal-status" }, "Starting the camera…");
      const controls = h("div", { class: "lab-controls" });
      const cardBox = h("div", { class: "lab-card" });

      root.append(
        h(
          "div",
          { class: "screen lab" },
          h(
            "header",
            { class: "topbar" },
            h("button", { class: "chip", onclick: () => app.go("home") }, "‹ Back"),
            h("div", { class: "title" }, "Vision lab"),
            h(
              "div",
              { class: "topbar-actions" },
              h(
                "button",
                { class: "chip", onclick: () => app.pipeline.relearnBackground(14) },
                "Relearn empty board",
              ),
            ),
          ),
          h(
            "div",
            { class: "lab-grid" },
            panel("Rectified board", rectified),
            panel("Occupancy — background subtraction", occupancy),
            panel("Ink — adaptive threshold", ink),
            panel("Tokens and tiles", found),
          ),
          h("div", { class: "lab-side" }, status, timings, readout.el, cardBox, controls),
        ),
      );

      // The lab asks for everything, which is also the worst case for the
      // frame budget: if it holds up here it holds up in any game.
      app.pipeline.setNeeds({ occupancy: true, ink: true, field: true, contours: true, tokens: true, tiles: true });

      /**
       * Live controls for the occupancy thresholds.
       *
       * These are the numbers that decide whether the board works, and they can
       * only be judged under a real mirror in a real room. Adjusting them here,
       * on the device, with the mask visible next to them, takes seconds;
       * guessing at them in a source file and redeploying takes a round trip
       * for every guess.
       */
      /*
       * What the calibration card measured, if one was ever scanned.
       *
       * Read-only, deliberately. These used to be things somebody guessed at
       * with a slider; showing the measurement next to the masks it produced is
       * the useful version of that, and there is nothing to drag.
       */
      const renderCard = () => {
        cardBox.textContent = "";
        const cal = app.calibration;
        const p = cal?.profile;
        if (!p) {
          cardBox.append(
            h("div", { class: "cal-caption" }, "No calibration card scanned — shipped defaults in use."),
          );
          return;
        }
        const rows: Array<[string, string]> = [
          ["ink contrast", p.ink.contrast.toFixed(3)],
          ["max luma", p.ink.maxLuma.toFixed(0)],
          ["lens blur", `${p.blur.toFixed(1)} px`],
          ["card scale", `${p.mmPerPixel.toFixed(3)} mm/px`],
          ["white gain", `${p.gain.r.toFixed(2)} ${p.gain.g.toFixed(2)} ${p.gain.b.toFixed(2)}`],
        ];
        if (cal?.playAreaMm) {
          rows.push(["play area", `${Math.round(cal.playAreaMm.w)} × ${Math.round(cal.playAreaMm.h)} mm`]);
        }
        cardBox.append(
          h("div", { class: "cal-caption" }, "From the calibration card"),
          ...rows.map(([k, v]) => h("div", { class: "lab-row" }, h("span", {}, k), h("b", {}, v))),
          ...p.palette.map((c) =>
            h(
              "div",
              { class: "lab-row" },
              h("span", {}, c.name),
              h("b", {}, `rgb(${c.rgb.map((v) => Math.round(v)).join(", ")})`),
            ),
          ),
          ...p.warnings.map((w) => h("div", { class: "cal-caption error" }, w)),
        );
      };
      renderCard();

      const renderControls = () => {
        const detector = app.pipeline.occupancyDetector;
        controls.textContent = "";
        if (!detector) return;
        const settings = detector.settings();

        const set = (patch: Parameters<typeof detector.configure>[0]) => {
          detector.configure(patch);
          renderControls();
        };

        controls.append(
          toggle("Correct exposure", settings.normaliseExposure, (on) =>
            set({ normaliseExposure: on }),
          ),
          toggle("Reject shadows", settings.rejectShadows, (on) => set({ rejectShadows: on })),
          slider("Floor", settings.threshold, 2, 48, 1, (v) => set({ threshold: v })),
          slider("Noise ×", settings.noiseFactor, 1, 8, 0.5, (v) => set({ noiseFactor: v })),
          slider("Denoise", settings.denoise, 0, 3, 1, (v) => set({ denoise: v })),
          h(
            "button",
            {
              class: "primary",
              onclick: () => {
                void capture();
              },
            },
            "Capture diagnostic",
          ),
        );
      };

      const capture = async () => {
        const bundle = captureDiagnostics(app);
        if (!bundle) {
          status.textContent = "Nothing to capture yet — wait for the camera.";
          return;
        }
        status.textContent = "Packaging…";
        try {
          const how = await shareBundle(bundle);
          status.textContent =
            how === "shared" ? "Shared." : "Saved to your downloads.";
        } catch {
          // A cancelled share sheet is not a failure worth shouting about.
          status.textContent = "";
        }
      };

      renderControls();

      void app
        .useCamera()
        .then(() => {
          status.textContent = "";
          stopFrames = onVideoFrame(app.camera.element, () => {
            const state = app.pipeline.step(performance.now());
            if (!state) return;

            putRgba(rectified, state.frame.rgba, board.w, board.h);
            drawMaskCanvas(occupancy, state.occupancy, [125, 159, 232]);
            drawMaskCanvas(ink, state.ink, [235, 200, 120]);
            drawFound(found, state);
            renderTimings(timings, state);
            readout.update(state, app);
          });
        })
        .catch((e) => {
          status.textContent = describeCameraError(e);
          status.classList.add("error");
        });
    },

    unmount() {
      stopFrames?.();
      stopFrames = null;
      owner?.releaseCamera();
      owner = null;
    },
  };
}

function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
): HTMLElement {
  const input = h("input", {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: (e: Event) => onInput(Number((e.target as HTMLInputElement).value)),
  });
  return h("label", { class: "lab-control" }, h("span", {}, `${label} ${value}`), input);
}

function toggle(label: string, on: boolean, onChange: (on: boolean) => void): HTMLElement {
  return h(
    "label",
    { class: "lab-control" },
    h("input", {
      type: "checkbox",
      checked: on,
      onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
    }),
    h("span", {}, label),
  );
}

function panel(title: string, canvas: HTMLCanvasElement): HTMLElement {
  return h("figure", { class: "lab-panel" }, canvas, h("figcaption", {}, title));
}

function drawMaskCanvas(canvas: HTMLCanvasElement, mask: Mask, rgb: [number, number, number]): void {
  const buf = new Uint8ClampedArray(mask.w * mask.h * 4);
  for (let i = 0; i < mask.data.length; i++) {
    const on = mask.data[i];
    const o = i * 4;
    buf[o] = on ? rgb[0] : 16;
    buf[o + 1] = on ? rgb[1] : 20;
    buf[o + 2] = on ? rgb[2] : 32;
    buf[o + 3] = 255;
  }
  putRgba(canvas, buf, mask.w, mask.h);
}

function drawFound(canvas: HTMLCanvasElement, state: VisionState): void {
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0d1220";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.lineWidth = 1;
  for (const contour of state.contours) {
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(contour[0], contour[1]);
    for (let i = 2; i < contour.length; i += 2) ctx.lineTo(contour[i], contour[i + 1]);
    ctx.closePath();
    ctx.stroke();
  }

  for (const token of state.tokens) {
    ctx.fillStyle = COLOR_SWATCH[token.color];
    ctx.globalAlpha = 0.3 + token.confidence * 0.7;
    ctx.beginPath();
    ctx.arc(token.cx, token.cy, Math.sqrt(token.area) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (const tile of state.tiles) {
    ctx.strokeStyle = tile.margin > 0.1 ? "#7d9fe8" : "#e6a05a";
    ctx.strokeRect(tile.cx - tile.size / 2, tile.cy - tile.size / 2, tile.size, tile.size);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "center";
    ctx.fillText(tile.char, tile.cx, tile.cy + 4);
  }
}

function renderTimings(el: HTMLElement, state: VisionState): void {
  const t = state.timings;
  const rows: Array<[string, number]> = [
    ["capture", t.capture],
    ["rectify", t.rectify],
    ["occupancy", t.occupancy],
    ["ink", t.ink],
    ["blobs", t.blobs],
    ["tiles", t.tiles],
    ["contours", t.contours],
    ["total", t.total],
  ];
  // Rebuilt as text rather than diffed: this is a debug panel and a per-frame
  // DOM diff would measure itself into the numbers it is reporting.
  el.textContent = "";
  el.append(
    h(
      "table",
      {},
      ...rows.map(([name, ms]) =>
        h(
          "tr",
          { class: name === "total" ? "total" : "" },
          h("td", {}, name),
          h("td", {}, `${ms.toFixed(2)} ms`),
        ),
      ),
    ),
  );
}

/**
 * The live readout.
 *
 * Built once, then only its values change. Rebuilding these rows every frame
 * reflowed the whole panel thirty times a second — and the two rows that vary
 * in length, tokens and tiles, dragged everything below them up and down while
 * you were trying to read it. So both are rendered at a fixed shape: tokens as
 * a count per colour in a constant order rather than one entry per token, and
 * the tile reading clipped to a fixed width.
 */
class Readout {
  readonly el: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();

  constructor() {
    this.el = h("div", { class: "lab-readout" });
    for (const key of ["board", "covered", "blobs", "exposure", "tokens", "tiles", "warning"]) {
      // A stable hook for the browser test: it reads these values to decide
      // whether the pipeline is seeing anything, and should not have to parse
      // rendered text that exists for a human's benefit.
      const value = h("span", { class: "lab-value", "data-stat": key }, "");
      const row = h(
        "div",
        { class: key === "warning" ? "lab-row warning" : "lab-row" },
        h("span", { class: "lab-key" }, key === "warning" ? "" : key),
        value,
      );
      this.rows.set(key, value);
      this.el.append(row);
    }
  }

  private set(key: string, text: string, error = false): void {
    const el = this.rows.get(key)!;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("error", error);
  }

  update(state: VisionState, app: App): void {
    const detector = app.pipeline.occupancyDetector;
    const pixels = state.board.w * state.board.h;

    this.set("board", `${state.board.w}×${state.board.h}`);
    this.set("covered", `${((state.coveredPixels / pixels) * 100).toFixed(1)}%`);
    this.set("blobs", String(state.blobs.length).padStart(3));
    this.set("exposure", detector ? describeGain(detector.gain) : "—");

    const counts = new Map<string, number>();
    for (const token of state.tokens) counts.set(token.color, (counts.get(token.color) ?? 0) + 1);
    // Full names, counts padded: the row keeps a constant width because the
    // palette is fixed, so nothing shifts as tokens come and go.
    const tokens = READOUT_COLORS.map((c) => `${c} ${String(counts.get(c) ?? 0).padStart(2)}`);
    this.set("tokens", tokens.join("  "));

    const read = state.tiles.map((t) => t.char).join("");
    this.set("tiles", read ? `${read.slice(0, 24)} (${state.tiles.length})` : "—");

    if (!state.ready) this.set("warning", "empty board not learned yet", true);
    else if (detector?.suspect) this.set("warning", "board reads as covered — reference is stale", true);
    else this.set("warning", "", false);
  }
}

/** Fixed order, so the row never changes width as tokens come and go. */
const READOUT_COLORS = ["red", "orange", "green", "blue"] as const;
