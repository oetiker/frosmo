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

import { COLOR_SWATCH } from "../../vision/color.js";
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
          h("div", { class: "lab-side" }, status, timings, readout),
        ),
      );

      // The lab asks for everything, which is also the worst case for the
      // frame budget: if it holds up here it holds up in any game.
      app.pipeline.setNeeds({ occupancy: true, ink: true, field: true, contours: true, tokens: true, tiles: true });

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
            renderReadout(readout, state);
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

function renderReadout(el: HTMLElement, state: VisionState): void {
  const pct = ((state.coveredPixels / (state.board.w * state.board.h)) * 100).toFixed(1);
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
  if (!state.ready) el.append(h("div", { class: "error" }, "empty board not learned yet"));
}
