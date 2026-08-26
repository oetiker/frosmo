/**
 * Play: one canvas, one game, one loop.
 *
 * The loop is driven by the camera rather than by the display. Rendering a
 * fresh frame when the vision state has not changed shows the player nothing
 * new and costs battery on a device that is already running its camera, its
 * screen at full brightness, and a 30fps readback.
 */

import { computeLayout, type GameEnv, type GameInstance } from "../../games/types.js";
import { fitCanvas, h, requestWakeLock } from "../../util/dom.js";
import { describeCameraError, onVideoFrame } from "../../vision/camera.js";
import type { App, Screen } from "../app.js";

/** Frames of empty table folded into the reference before play starts. */
const LEARN_FRAMES = 14;
/** dt is clamped here: a backgrounded tab must not teleport every ball at once. */
const MAX_DT = 1 / 20;

export function playScreen(gameId?: string): Screen {
  let stopFrames: (() => void) | null = null;
  let wakeLock: WakeLockSentinel | null = null;
  let instance: GameInstance | null = null;
  let owner: App | null = null;
  let lastTime = 0;
  let started = 0;
  const taps: Array<{ x: number; y: number }> = [];

  return {
    mount(app: App, root: HTMLElement) {
      owner = app;
      const def = gameId ? app.game(gameId) : undefined;
      if (!def) {
        app.go("home");
        return;
      }

      const board = { w: 1, h: 1 / (app.calibration?.aspect ?? 4 / 3) };
      instance = def.create(board);

      const canvas = h("canvas", { class: "play-canvas" });
      const score = h("div", { class: "hud-score" }, "0");
      const timer = h("div", { class: "hud-timer" }, "");
      const message = h("div", { class: "hud-message" }, "");
      const detail = h("div", { class: "hud-detail" }, def.how[0]);
      const bar = h("div", { class: "hud-bar-fill" });
      const overlay = h("div", { class: "play-overlay" });

      root.append(
        h(
          "div",
          { class: "screen play" },
          canvas,
          h(
            "div",
            { class: "hud" },
            h(
              "div",
              { class: "hud-top" },
              h("button", { class: "chip", onclick: () => app.go("home") }, "‹ Games"),
              h("div", { class: "hud-title" }, `${def.emoji} ${def.title}`),
              h(
                "div",
                { class: "hud-right" },
                timer,
                score,
                h(
                  "button",
                  {
                    class: "chip",
                    onclick: () => {
                      instance?.reset();
                      app.pipeline.relearnBackground(LEARN_FRAMES);
                      showLearning();
                    },
                  },
                  "↻",
                ),
              ),
            ),
            h("div", { class: "hud-centre" }, message, detail, h("div", { class: "hud-bar" }, bar)),
          ),
          overlay,
        ),
      );

      canvas.addEventListener("pointerdown", (e) => {
        app.audio.unlock();
        const rect = canvas.getBoundingClientRect();
        const layout = computeLayout(rect.width, rect.height, board);
        taps.push({
          x: (e.clientX - rect.left - layout.x) / layout.scale,
          y: (e.clientY - rect.top - layout.y) / layout.scale,
        });
      });

      const showLearning = () => {
        overlay.className = "play-overlay show";
        overlay.textContent = "Clear the play area…";
      };

      /**
       * Stop rather than play on a board calibrated with a different camera.
       *
       * The corners are only meaningful in the frame they were marked in, so
       * this would not be a slightly-off board — it would be a game reacting to
       * the wrong part of the world, which reads as the app being broken.
       */
      const showCameraMismatch = () => {
        overlay.className = "play-overlay show";
        overlay.textContent = "";
        overlay.append(
          h("div", {}, "This board was set up with a different camera."),
          h(
            "button",
            { class: "primary", onclick: () => app.go("calibrate") },
            "Set the board up again",
          ),
        );
      };
      const hideOverlay = () => {
        overlay.className = "play-overlay";
      };

      app.pipeline.setNeeds(def.needs);
      if (!app.pipeline.calibrated) {
        app.pipeline.relearnBackground(LEARN_FRAMES);
        showLearning();
      }

      void requestWakeLock().then((lock) => (wakeLock = lock));

      void app
        .useCamera()
        .then(() => {
          if (!app.cameraMatchesCalibration()) {
            showCameraMismatch();
            return;
          }
          started = performance.now();
          lastTime = started;

          stopFrames = onVideoFrame(app.camera.element, () => {
            const now = performance.now();
            const dt = Math.min(MAX_DT, (now - lastTime) / 1000);
            lastTime = now;

            const vision = app.pipeline.step(now);
            if (!vision) return;

            if (!vision.ready) {
              showLearning();
              return;
            }
            hideOverlay();

            const { w, h: ch } = fitCanvas(canvas);
            const ctx = canvas.getContext("2d")!;
            const layout = computeLayout(w, ch, board);

            const env: GameEnv = {
              ctx,
              layout,
              board,
              vision,
              dt,
              time: (now - started) / 1000,
              audio: app.audio,
              taps: taps.splice(0, taps.length),
            };

            instance!.update(env);

            ctx.clearRect(0, 0, w, ch);
            ctx.save();
            // The play area gets a visible frame: without it a player cannot
            // tell "nothing is detected" from "my piece is outside the board".
            ctx.fillStyle = "#0d1220";
            ctx.fillRect(layout.x, layout.y, layout.w, layout.h);
            instance!.render(env);
            ctx.restore();
            ctx.strokeStyle = "rgba(125,159,232,0.35)";
            ctx.lineWidth = 2;
            ctx.strokeRect(layout.x, layout.y, layout.w, layout.h);

            const hud = instance!.hud();
            score.textContent = String(hud.score ?? 0);
            timer.textContent = hud.timeLeft === undefined ? "" : formatTime(hud.timeLeft);
            message.textContent = hud.message ?? "";
            detail.textContent = hud.detail ?? "";
            bar.style.width = `${Math.round(Math.min(1, Math.max(0, hud.progress ?? 0)) * 100)}%`;
          });
        })
        .catch((e) => {
          overlay.className = "play-overlay show error";
          overlay.textContent = describeCameraError(e);
        });
    },

    unmount() {
      stopFrames?.();
      stopFrames = null;
      void wakeLock?.release().catch(() => undefined);
      wakeLock = null;
      instance = null;
      owner?.releaseCamera();
      owner = null;
    },
  };
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
