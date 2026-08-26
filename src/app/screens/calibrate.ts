/**
 * Calibration: the one screen that deals with the physical world.
 *
 * The player drags four handles onto the corners of the play area in the live
 * camera image, and sees the rectified result next to it as they drag. That
 * side-by-side is the whole design: nobody can judge a homography from four
 * dots, but anyone can tell whether the preview looks like the table.
 *
 * After the corners come two things the geometry cannot infer — which way round
 * the board is (a mirror reverses handedness, and whether it does depends on the
 * rig) and what the empty table looks like.
 */

import { h, putRgba } from "../../util/dom.js";
import { letterbox, normaliseInRect, type Rect } from "../../util/layout.js";
import {
  boardSize,
  boardToCamera,
  cornersToPixels,
  defaultCalibration,
  normaliseCorners,
  type Calibration,
  type Orientation,
} from "../../vision/calibration.js";
import { describeCameraError, onVideoFrame } from "../../vision/camera.js";
import { describeCamera, watchCameras, type CameraChoice } from "../../vision/cameras.js";
import type { Quad } from "../../vision/homography.js";
import { createRectifiedFrame, buildSampleTable, rectify } from "../../vision/rectify.js";

const HANDLE_LABELS = ["1", "2", "3", "4"];

export function calibrateScreen() {
  let stopFrames: (() => void) | null = null;
  let draft: Calibration = defaultCalibration();
  let dragging = -1;
  let learning = 0;
  let owner: import("../app.js").App | null = null;
  let stopWatchingCameras: (() => void) | null = null;

  return {
    mount(app: import("../app.js").App, root: HTMLElement) {
      owner = app;
      draft = app.calibration ? { ...app.calibration, corners: [...app.calibration.corners] as Quad } : defaultCalibration();

      const video = app.camera.element;
      video.className = "cal-video";

      const overlay = h("canvas", { class: "cal-overlay" });
      const preview = h("canvas", { class: "cal-preview", width: "256", height: "192" });
      const status = h("div", { class: "cal-status" }, "Starting the camera…");
      const cameraPicker = h("div", { class: "cal-camera" }, h("span", { class: "cal-caption" }, "…"));

      const orientationLabel = h("span", {}, orientationName(draft.orientation));

      const stage = h("div", { class: "cal-stage" }, video, overlay);

      root.append(
        h(
          "div",
          { class: "screen calibrate" },
          h(
            "header",
            { class: "topbar" },
            h("button", { class: "chip", onclick: () => app.go("home") }, "‹ Back"),
            h("div", { class: "title" }, "Set up the board"),
            h("div", { class: "topbar-actions" }),
          ),
          h(
            "div",
            { class: "cal-body" },
            stage,
            h(
              "aside",
              { class: "cal-side" },
              h(
                "ol",
                { class: "steps" },
                h("li", {}, "Clip the mirror over the camera so it looks at the table."),
                h("li", {}, "Pick the camera that faces the table, if there is more than one."),
                h("li", {}, "Drag the four handles onto the corners of the play area."),
                h("li", {}, "Check the preview looks like your table, right way round."),
                h("li", {}, "Clear the table, then learn the empty board."),
              ),
              h("div", { class: "row" }, h("label", {}, "Camera"), cameraPicker),
              h("div", { class: "cal-preview-wrap" }, preview, h("span", { class: "cal-caption" }, "What the games will see")),
              h(
                "div",
                { class: "row" },
                h("button", { class: "ghost", onclick: () => rotate(1) }, "Rotate"),
                h("button", { class: "ghost", onclick: () => flip() }, "Mirror"),
                orientationLabel,
              ),
              h(
                "div",
                { class: "row" },
                h("label", {}, "Play area shape"),
                select(
                  [
                    ["1.333", "4:3 (a sheet of A4 across)"],
                    ["1.5", "3:2"],
                    ["1.777", "16:9 (wide)"],
                    ["1", "Square"],
                  ],
                  String(round3(draft.aspect)),
                  (v) => {
                    draft.aspect = Number(v);
                    resizePreview();
                  },
                ),
              ),
              h(
                "div",
                { class: "row" },
                h("label", {}, "Detail"),
                select(
                  [
                    ["192", "Lower — fastest"],
                    ["256", "Normal"],
                    ["320", "Higher — small pieces"],
                  ],
                  String(draft.resolution),
                  (v) => {
                    draft.resolution = Number(v);
                    resizePreview();
                  },
                ),
              ),
              status,
              h(
                "div",
                { class: "row" },
                h("button", { class: "ghost", onclick: () => reset() }, "Reset corners"),
                h(
                  "button",
                  {
                    class: "primary",
                    onclick: () => {
                      app.audio.unlock();
                      save(app);
                    },
                  },
                  "Learn empty board & save",
                ),
              ),
            ),
          ),
        ),
      );

      let frame = createRectifiedFrame(boardSize(draft));
      let table: Int32Array | null = null;
      let tableFor = { w: 0, h: 0 };

      const resizePreview = () => {
        const size = boardSize(draft);
        frame = createRectifiedFrame(size);
        preview.width = size.w;
        preview.height = size.h;
        table = null;
      };
      resizePreview();

      const rotate = (by: number) => {
        draft.orientation = (((draft.orientation % 4) + by + 4) % 4 |
          (draft.orientation >= 4 ? 4 : 0)) as Orientation;
        orientationLabel.textContent = orientationName(draft.orientation);
        table = null;
      };
      const flip = () => {
        draft.orientation = ((draft.orientation + 4) % 8) as Orientation;
        orientationLabel.textContent = orientationName(draft.orientation);
        table = null;
      };
      const reset = () => {
        draft.corners = defaultCalibration().corners;
        table = null;
      };

      const save = (a: import("../app.js").App) => {
        a.setCalibration({
          ...draft,
          cameraId: a.camera.activeDeviceId ?? undefined,
          cameraLabel: a.camera.activeLabel ?? undefined,
          createdAt: Date.now(),
        });
        learning = 100;
        status.textContent = "Clear the table — learning the empty board…";
        a.pipeline.relearnBackground(14);
        setTimeout(() => {
          status.textContent = "Saved. The board is ready.";
          a.go("home");
        }, 2200);
      };

      // --- dragging ------------------------------------------------------

      // The video is drawn with object-fit: contain, so it does not fill the
      // stage unless the camera's aspect happens to match it. Corners are
      // stored relative to the *frame*, so every conversion here goes through
      // the displayed content rect rather than the element box.
      const contentRect = (): Rect => {
        const box = overlay.getBoundingClientRect();
        const { w: vw, h: vh } = app.camera.size;
        if (!vw || !vh) return { x: 0, y: 0, w: box.width, h: box.height };
        return letterbox(box.width, box.height, vw / vh);
      };

      const handleAt = (px: number, py: number): number => {
        const rect = contentRect();
        let best = -1;
        let bestD = 44;
        draft.corners.forEach((c, i) => {
          const d = Math.hypot(rect.x + c.x * rect.w - px, rect.y + c.y * rect.h - py);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        return best;
      };

      const toNormalised = (e: PointerEvent) => {
        const box = overlay.getBoundingClientRect();
        return normaliseInRect(contentRect(), e.clientX - box.left, e.clientY - box.top);
      };

      overlay.addEventListener("pointerdown", (e) => {
        const rect = overlay.getBoundingClientRect();
        dragging = handleAt(e.clientX - rect.left, e.clientY - rect.top);
        if (dragging >= 0) overlay.setPointerCapture(e.pointerId);
      });
      overlay.addEventListener("pointermove", (e) => {
        if (dragging < 0) return;
        e.preventDefault();
        draft.corners[dragging] = toNormalised(e);
        table = null;
      });
      const endDrag = () => {
        if (dragging < 0) return;
        dragging = -1;
        // Re-order only when the drag finishes: reordering mid-drag swaps the
        // handle out from under the finger.
        const ordered = normaliseCorners(cornersToPixels(draft, 1000, 1000), 1000, 1000);
        if (ordered) draft.corners = ordered;
        table = null;
      };
      overlay.addEventListener("pointerup", endDrag);
      overlay.addEventListener("pointercancel", endDrag);

      // --- live loop -----------------------------------------------------
      /**
       * Rebuild the picker from whatever is attached.
       *
       * Only called once a stream is running: before permission is granted the
       * devices come back with blank labels, and a list of "Camera 1, Camera 2"
       * is no help at all when the whole question is which one faces the
       * mirror.
       */
      const renderCameraPicker = () => {
        const cameras = app.cameras;
        const active = app.camera.activeDeviceId;
        cameraPicker.textContent = "";

        if (cameras.length === 0) {
          cameraPicker.append(h("span", { class: "cal-caption" }, "No camera list available"));
          return;
        }
        if (cameras.length === 1) {
          cameraPicker.append(
            h("span", { class: "cal-caption" }, describeCamera(cameras[0], 0)),
          );
          return;
        }

        const chosen = cameras.find((c) => c.deviceId === active)?.deviceId ?? cameras[0].deviceId;
        cameraPicker.append(
          select(
            cameras.map((c, i) => [c.deviceId, describeCamera(c, i)] as [string, string]),
            chosen,
            (deviceId) => {
              const choice = cameras.find((c) => c.deviceId === deviceId) ?? null;
              void switchCamera(choice);
            },
          ),
        );
      };

      const switchCamera = async (choice: CameraChoice | null) => {
        status.textContent = "Switching camera…";
        try {
          await app.selectCamera(choice);
          // A different camera means a different frame: the gather table and
          // anything learned about the board belong to the old one.
          table = null;
          app.pipeline.forgetBackground();
          status.textContent = "Camera changed — check the corners still line up.";
        } catch (e) {
          status.textContent = describeCameraError(e);
          status.classList.add("error");
        }
        renderCameraPicker();
      };

      stopWatchingCameras = watchCameras(() => {
        void app.refreshCameras().then(renderCameraPicker);
      });

      void app
        .useCamera()
        .then(() => {
          renderCameraPicker();
          status.textContent = "Drag the handles onto the corners of the play area.";
          stopFrames = onVideoFrame(video, () => {
            const size = { w: overlay.clientWidth, h: overlay.clientHeight };
            if (size.w && size.h) {
              overlay.width = size.w * Math.min(2, devicePixelRatio || 1);
              overlay.height = size.h * Math.min(2, devicePixelRatio || 1);
            }
            const box = overlay.getBoundingClientRect();
            const { w: vw, h: vh } = app.camera.size;
            drawOverlay(
              overlay,
              draft.corners,
              dragging,
              vw && vh ? letterbox(box.width, box.height, vw / vh) : { x: 0, y: 0, w: box.width, h: box.height },
            );

            const shot = app.camera.capture(0.5);
            if (!shot) return;
            if (!table || tableFor.w !== shot.w || tableFor.h !== shot.h) {
              try {
                table = buildSampleTable(
                  boardToCamera(draft, shot.w, shot.h),
                  { w: frame.size.w, h: frame.size.h },
                  shot.w,
                  shot.h,
                );
                tableFor = { w: shot.w, h: shot.h };
              } catch {
                // Corners momentarily collinear mid-drag: skip this frame
                // rather than showing an error the user cannot act on.
                return;
              }
            }
            rectify(shot.data, table, frame);
            putRgba(preview, frame.rgba, frame.size.w, frame.size.h);

            if (learning > 0) learning--;
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
      stopWatchingCameras?.();
      stopWatchingCameras = null;
      owner?.releaseCamera();
      owner = null;
    },
  };
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  corners: Quad,
  active: number,
  content: Rect,
): void {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // The canvas is sized in device pixels while the content rect is in CSS
  // pixels; one scale factor relates them.
  const k = content.w > 0 ? w / (canvas.getBoundingClientRect().width || w) : 1;
  const pts = corners.map((c) => ({
    x: (content.x + c.x * content.w) * k,
    y: (content.y + c.y * content.h) * k,
  }));

  // Dim everything outside the play area so the quad reads as a window.
  ctx.fillStyle = "rgba(6, 10, 20, 0.55)";
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill("evenodd");

  ctx.strokeStyle = "#7d9fe8";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();

  pts.forEach((p, i) => {
    const r = i === active ? 26 : 20;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === active ? "rgba(125,159,232,0.95)" : "rgba(125,159,232,0.65)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "700 16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(HANDLE_LABELS[i], p.x, p.y);
  });
}

function select(
  options: Array<[string, string]>,
  value: string,
  onchange: (v: string) => void,
): HTMLSelectElement {
  const el = h(
    "select",
    { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
    ...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
  );
  el.value = value;
  return el;
}

function orientationName(o: Orientation): string {
  const turns = ["up", "right", "down", "left"][o % 4];
  return o >= 4 ? `mirrored, ${turns}` : turns;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
