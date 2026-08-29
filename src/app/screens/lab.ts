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
      const readout = h("div", { class: "lab-readout" });
      const status = h("div", { class: "cal-status" }, "Starting the camera…");
      const controls = h("div", { class: "lab-controls" });

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
          h("div", { class: "lab-side" }, status, timings, readout, controls),
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
            renderReadout(readout, state, app);
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

function renderReadout(el: HTMLElement, state: VisionState, app: App): void {
  const pct = ((state.coveredPixels / (state.board.w * state.board.h)) * 100).toFixed(1);
  const detector = app.pipeline.occupancyDetector;
  el.textContent = "";
  el.append(
    h("div", {}, `board ${state.board.w}×${state.board.h}`),
    h("div", {}, `covered ${pct}%`),
    h("div", {}, `blobs ${state.blobs.length}`),
    h(
      "div",
      {},
      `tokens ${state.tokens.map((t) => t.color).join(", ") || "—"}`,
    ),
    h(
      "div",
      {},
      `tiles ${state.tiles.map((t) => `${t.char}(${t.margin.toFixed(2)})`).join(" ") || "—"}`,
    ),
  );
  if (detector) {
    // The exposure the camera applied behind our backs. Near 1.00 means it is
    // holding still; anything else means auto-exposure was about to be blamed
    // for a detector's behaviour.
    el.append(h("div", {}, `exposure ${describeGain(detector.gain)}`));
    if (detector.suspect) {
      el.append(
        h("div", { class: "error" }, "board reads as covered — the reference is probably stale"),
      );
    }
  }
  if (!state.ready) el.append(h("div", { class: "error" }, "empty board not learned yet"));
}
