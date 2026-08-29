/**
 * Capturing what the rig actually sees.
 *
 * Everything hard about this app happens under a particular mirror, in a
 * particular room, on a particular table. A synthetic test scene has perfect
 * exposure, no sensor noise and no shadows — which is precisely why detectors
 * tuned against one pass their tests and then fail on a kitchen table.
 *
 * This packages one moment of the real thing — the native-resolution camera
 * frame, the rectified board, the learned reference, the current mask, and
 * every setting that produced them — into a single file that can be shared off
 * the device. That file is enough to reproduce a detector's behaviour exactly,
 * and to turn "the tokens don't work" into a fixture with a failing test.
 */

import type { App } from "./app.js";
import { describeGain } from "../vision/photometry.js";

export const DIAGNOSTIC_VERSION = 1;

export interface DiagnosticBundle {
  version: number;
  capturedAt: string;
  url: string;
  userAgent: string;
  camera: Record<string, unknown>;
  calibration: unknown;
  occupancy: Record<string, unknown>;
  stats: Record<string, unknown>;
  timings: unknown;
  /** PNG data URLs. */
  images: Record<string, string>;
}

/** Encode an RGBA buffer as a PNG data URL. */
function toPng(data: Uint8ClampedArray, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Build a bundle from the app's current state.
 *
 * The raw frame is captured at full resolution, not at the scale the pipeline
 * runs at: the question the bundle most often has to answer is whether there
 * was ever enough detail in the image, and a downscaled copy cannot answer it.
 */
export function captureDiagnostics(app: App): DiagnosticBundle | null {
  const state = app.pipeline.latest();
  const detector = app.pipeline.occupancyDetector;
  if (!state || !detector) return null;

  const images: Record<string, string> = {};

  const raw = app.camera.capture(1);
  if (raw) images.raw = toPng(raw.data, raw.w, raw.h);

  const { w, h } = state.board;
  images.rectified = toPng(state.frame.rgba, w, h);

  const background = new Uint8ClampedArray(w * h * 4);
  app.pipeline.backgroundRgba(background);
  images.background = toPng(background, w, h);

  images.occupancy = toPng(maskToRgba(state.occupancy.data, w, h), w, h);
  images.ink = toPng(maskToRgba(state.ink.data, w, h), w, h);

  const track = app.camera.element.srcObject as MediaStream | null;
  const settings = track?.getVideoTracks()[0]?.getSettings() ?? {};

  return {
    version: DIAGNOSTIC_VERSION,
    capturedAt: new Date().toISOString(),
    url: location.href,
    userAgent: navigator.userAgent,
    camera: {
      label: app.camera.activeLabel,
      deviceId: app.camera.activeDeviceId,
      captured: raw ? { w: raw.w, h: raw.h } : null,
      settings: settings as unknown as Record<string, unknown>,
    },
    calibration: app.calibration,
    occupancy: detector.settings(),
    stats: {
      board: state.board,
      gain: detector.gain,
      gainText: describeGain(detector.gain),
      coveredFraction: detector.coveredFraction,
      suspect: detector.suspect,
      blobs: state.blobs.length,
      tokens: state.tokens.map((t) => ({
        color: t.color,
        confidence: t.confidence,
        area: t.area,
        rgb: [t.blob.r, t.blob.g, t.blob.b],
      })),
      tiles: state.tiles.map((t) => ({
        char: t.char,
        score: t.score,
        margin: t.margin,
        size: t.size,
      })),
    },
    timings: state.timings,
    images,
  };
}

function maskToRgba(mask: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] ? 255 : 0;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function diagnosticFilename(bundle: DiagnosticBundle): string {
  return `frosmo-diagnostic-${bundle.capturedAt.replace(/[:.]/g, "-")}.json`;
}

/**
 * Get the bundle off the device.
 *
 * The share sheet first: on iPadOS that is how a file reaches Mail, Files or
 * AirDrop, and a home-screen web app has no visible downloads folder to browse
 * afterwards. A download link is the fallback for desktop browsers.
 */
export async function shareBundle(bundle: DiagnosticBundle): Promise<"shared" | "downloaded"> {
  const name = diagnosticFilename(bundle);
  const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });

  const file = new File([blob], name, { type: "application/json" });
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title?: string }) => Promise<void>;
  };

  if (nav.canShare?.({ files: [file] }) && nav.share) {
    await nav.share({ files: [file], title: "frosmo diagnostic" });
    return "shared";
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough and the object is small.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}
