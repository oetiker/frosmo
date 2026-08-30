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
import { findRings } from "../../vision/card-finder.js";
import {
  areaFromCorners,
  playAreaMm,
  scanCard,
} from "../../vision/card-scan.js";
import type { Mat3 } from "../../vision/homography.js";
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
      const cardNote = h("div", { class: "cal-caption cal-card-note" }, "");
      const scanNote = h("div", { class: "cal-scan-note" }, "");
      /**
       * The button is the one thing the eye is certainly on when it is pressed.
       *
       * Whatever else changes, this does, at the point of the finger. A line of
       * text elsewhere on the screen is a change nobody is looking at.
       */
      const scanButton = h(
        "button",
        { class: "primary", onclick: () => scan(app) },
        "Scan card",
      ) as HTMLButtonElement;
      /**
       * Where the last scan thought it saw ring-shaped marks, over the live
       * picture, in frame coordinates.
       *
       * "Found 3 of the 5 rings" is a number; this is where they were. Which
       * mark went missing, and what on the table is being taken for one, are
       * the two questions that follow, and neither can be answered by counting.
       */
      let sawRings: Array<{ x: number; y: number; r: number }> = [];
      const aspectPicker = select(
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
      );

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
                h("li", {}, "Lay the printed card where you want to play and scan it — or drag the four handles yourself."),
                h("li", {}, "Check the preview looks like your table, right way round."),
                h("li", {}, "Take the card away, clear the table, then learn the empty board."),
              ),
              h("div", { class: "row" }, h("label", {}, "Camera"), cameraPicker),
              h(
                "div",
                { class: "row" },
                scanButton,
                h("button", { class: "ghost", onclick: () => app.go("card") }, "Print the card"),
              ),
              scanNote,
              cardNote,
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
                aspectPicker,
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
      /**
       * The plane the card established, kept for as long as this screen lives.
       *
       * The card can be taken away the moment it has been scanned; the surface
       * it was lying on has not moved, so the homography still describes it.
       * That is what lets a dragged handle stay measured in millimetres.
       */
      let plane: { m: Mat3; frame: { w: number; h: number } } | null = null;
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

      /**
       * Read the printed card, and let it set everything it can.
       *
       * Corners, aspect, orientation and the rig profile all at once, because
       * they are all measurements of the same photograph and a card that set
       * only the corners would leave the numbers that actually decide whether a
       * letter is read at their shipped defaults.
       *
       * A single frame, at full capture resolution. Nothing here is per-frame
       * work — the player has laid a card down and pressed a button — so there
       * is no reason to look at a half-size image for it.
       */
      /**
       * Read the printed card, and let it set everything it can.
       *
       * Corners, aspect, orientation and the rig profile all at once, because
       * they are all measurements of the same photograph and a card that set
       * only the corners would leave the numbers that actually decide whether a
       * letter is read at their shipped defaults.
       *
       * Every outcome, including the failures, is written next to the button.
       * The first version put them in the status line at the bottom of the
       * sidebar, below the preview and three more controls, where on a tablet
       * it is off the bottom of the screen — so a scan that ran, failed and
       * said exactly why was indistinguishable from a button that did nothing.
       */
      const scan = (a: import("../app.js").App) => {
        if (scanButton.disabled) return;
        scanButton.disabled = true;
        scanButton.textContent = "Scanning…";
        sawRings = [];
        say("Looking for the card…");
        // Let that paint before the frame is chewed on: everything below is
        // synchronous, and on a tablet it is long enough to look like a hang.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            try {
              runScan(a);
            } finally {
              scanButton.disabled = false;
              scanButton.textContent = "Scan card";
            }
          }),
        );
      };

      const runScan = (a: import("../app.js").App) => {
        let shot;
        try {
          shot = a.camera.capture(scanScale(a));
        } catch (e) {
          say(`The camera would not give a frame: ${message(e)}`, true);
          return;
        }
        if (!shot) {
          say("No camera frame yet — wait for the picture to appear.", true);
          return;
        }

        let seen;
        try {
          seen = scanCard(shot.data, shot.w, shot.h, { resolution: draft.resolution });
        } catch (e) {
          say(`The scan failed: ${message(e)}`, true);
          return;
        }

        if (!seen) {
          // Say what was actually seen. One ring short and five missing are the
          // same sentence otherwise, and they want opposite things done.
          const gray = new Uint8ClampedArray(shot.w * shot.h);
          for (let i = 0; i < gray.length; i++) {
            const j = i * 4;
            gray[i] = (shot.data[j] * 77 + shot.data[j + 1] * 150 + shot.data[j + 2] * 29) >> 8;
          }
          const rings = findRings(gray, shot.w, shot.h);
          sawRings = rings.map((r) => ({
            x: r.x / shot.w,
            y: r.y / shot.h,
            r: r.size / 2 / shot.w,
          }));
          /*
           * Three different situations, and they want different things done.
           * The count alone is not the story: five marks that refuse to be a
           * card is a different problem from three marks, and saying "found 5
           * of the 5 rings" when the scan failed anyway is worse than saying
           * nothing.
           */
          say(
            rings.length === 0
              ? "No card in view. It needs to lie flat under the mirror, printed side up."
              : rings.length < 5
                ? `Only ${rings.length} of the card's 5 marks are in view, circled on the picture. Move the card fully under the mirror and keep anything off it.`
                : `${rings.length} round marks in view, circled on the picture, but they do not make a card — one of the five is probably hidden and something else is being taken for it.`,
            true,
          );
          return;
        }

        sawRings = [];
        plane = { m: seen.cardToCamera, frame: { w: shot.w, h: shot.h } };
        Object.assign(draft, seen.calibration, { resolution: draft.resolution });
        orientationLabel.textContent = orientationName(draft.orientation);
        showMeasuredAspect();
        table = null;
        resizePreview();
        renderCardNote();

        const p = seen.profile;
        const grew = seen.area.u1 - seen.area.u0 > 0.9;
        say(
          p.warnings.length
            ? `Card read, but: ${p.warnings.join("; ")}`
            : grew
              ? "Card read, and the board grown out to the edge of the view."
              : "Card read. The board stops at the card — no room to grow into.",
        );
      };

      /** Put a line where the eye already is, and in the status line too. */
      const say = (text: string, bad = false) => {
        scanNote.textContent = text;
        scanNote.classList.toggle("error", bad);
        status.textContent = text;
        status.classList.toggle("error", bad);
      };

      const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

      /**
       * How much of the camera frame to read for a scan.
       *
       * Not all of it. A ring is about an eighth of the card across, so it is
       * tens of pixels wide long before the frame is; reading a 12-megapixel
       * sensor instead buys nothing and asks for a summed-area table of eight
       * million doubles on a device that may not have it to spare.
       */
      const scanScale = (a: import("../app.js").App) => {
        const { w, h } = a.camera.size;
        const long = Math.max(w, h);
        return long > 1600 ? 1600 / long : 1;
      };

      /**
       * Offer the measured shape in the picker, rather than the nearest preset.
       *
       * The board grown out from the card has whatever aspect the camera's view
       * allowed; rounding it to 4:3 would throw away the one thing the scan
       * actually established.
       */
      const showMeasuredAspect = () => {
        const mm = draft.playAreaMm;
        if (!mm) return;
        const value = String(round3(draft.aspect));
        const label = `Measured — ${Math.round(mm.w)} × ${Math.round(mm.h)} mm`;
        const first = aspectPicker.options[0];
        if (first?.dataset.measured) {
          first.value = value;
          first.textContent = label;
        } else {
          const option = h("option", { value }, label);
          option.dataset.measured = "1";
          aspectPicker.prepend(option);
        }
        aspectPicker.value = value;
      };

      const renderCardNote = () => {
        const p = draft.profile;
        const mm = draft.playAreaMm;
        cardNote.textContent = !p
          ? ""
          : [
              mm ? `${Math.round(mm.w)} × ${Math.round(mm.h)} mm` : null,
              `ink ${p.ink.contrast.toFixed(2)}`,
              `blur ${p.blur.toFixed(1)} px`,
            ]
              .filter(Boolean)
              .join(" · ");
      };

      /**
       * Re-derive the physical size after the handles have been moved.
       *
       * Without this a drag would leave `playAreaMm` describing the rectangle
       * the card grew to, not the one now on screen — a wrong measurement,
       * which is worse than none, because the tile finder believes it.
       */
      const remeasure = () => {
        if (!plane || !draft.playAreaMm) return;
        const pixels = cornersToPixels(draft, plane.frame.w, plane.frame.h);
        const mm = playAreaMm(areaFromCorners(pixels, plane.m));
        draft.playAreaMm = mm;
        draft.aspect = mm.w / mm.h;
        showMeasuredAspect();
        resizePreview();
        renderCardNote();
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
        remeasure();
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
              sawRings,
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
  marks: Array<{ x: number; y: number; r: number }> = [],
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

  /*
   * What the scan took for a registration mark, when it could not make a card
   * out of them. Drawn over the picture rather than described in a sentence:
   * the useful facts are which corner is missing and what else on the table is
   * round and hollow, and both are things to be looked at.
   */
  for (const m of marks) {
    const x = (content.x + m.x * content.w) * k;
    const y = (content.y + m.y * content.h) * k;
    const r = Math.max(8, m.r * content.w * k * 1.6);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

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
