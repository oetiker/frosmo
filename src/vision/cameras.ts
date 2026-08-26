/**
 * Choosing which camera to use.
 *
 * The rig decides this, not the app. A reflector clipped over the front camera
 * wants the front one; a phone or tablet propped face-down over the table on a
 * stand wants the back one; a laptop with a mirror on a book wants whichever
 * external webcam is pointed at the table. There is no sensible default across
 * those, so the choice is the player's and it is remembered.
 *
 * Two facts shape everything here:
 *
 *   - **Labels only exist after permission is granted.** Before that,
 *     enumerateDevices returns entries with empty labels, so the picker has to
 *     be populated *after* a stream has started, not before.
 *   - **deviceId is not stable forever.** It is stable per origin, but clearing
 *     site data rotates it. A stored choice therefore keeps the label too, and
 *     falls back to matching on that when the id no longer exists.
 */

import { load, remove, save } from "../util/storage.js";

export interface CameraChoice {
  deviceId: string;
  label: string;
}

const STORE_KEY = "camera";

/**
 * Video inputs currently attached.
 *
 * Returns an empty list rather than throwing when the browser has no device
 * enumeration at all: the app then falls back to a plain facingMode request,
 * which is what it did before this feature existed.
 */
export async function listCameras(): Promise<CameraChoice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

/**
 * Resolve a remembered choice against what is actually attached.
 *
 * Order matters: the id is authoritative when it still exists, the label
 * rescues the common case of an id that rotated, and neither matching means
 * the camera is genuinely gone — a webcam unplugged — so the caller falls back
 * to its default rather than requesting a device that cannot be opened.
 */
export function resolveCamera(
  available: CameraChoice[],
  preference: CameraChoice | null,
): CameraChoice | null {
  if (!preference || available.length === 0) return null;

  const byId = available.find((c) => c.deviceId && c.deviceId === preference.deviceId);
  if (byId) return byId;

  const label = preference.label.trim();
  if (label) {
    const byLabel = available.find((c) => c.label.trim() === label);
    if (byLabel) return byLabel;
  }

  return null;
}

export function loadCameraPreference(): CameraChoice | null {
  const stored = load<CameraChoice | null>(STORE_KEY, null);
  if (!stored || typeof stored.deviceId !== "string") return null;
  return { deviceId: stored.deviceId, label: typeof stored.label === "string" ? stored.label : "" };
}

export function saveCameraPreference(choice: CameraChoice | null): void {
  if (choice) save(STORE_KEY, choice);
  else remove(STORE_KEY);
}

/**
 * A name to show in the picker.
 *
 * Safari labels its own cameras usefully ("Front Camera", "Back Camera"), but
 * a device can still come back unlabelled — before permission, or for some
 * virtual cameras — and "Camera 2" beats a blank row in a list.
 */
export function describeCamera(choice: CameraChoice, index: number): string {
  const label = choice.label.trim();
  return label || `Camera ${index + 1}`;
}

/** Notify when cameras are attached or removed. Returns an unsubscribe function. */
export function watchCameras(onChange: () => void): () => void {
  const target = navigator.mediaDevices;
  if (!target?.addEventListener) return () => undefined;
  target.addEventListener("devicechange", onChange);
  return () => target.removeEventListener("devicechange", onChange);
}
