import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeCamera,
  listCameras,
  loadCameraPreference,
  resolveCamera,
  saveCameraPreference,
  watchCameras,
  type CameraChoice,
} from "../src/vision/cameras.js";

const cam = (deviceId: string, label = ""): CameraChoice => ({ deviceId, label });

const FRONT = cam("aaa111", "Front Camera");
const BACK = cam("bbb222", "Back Camera");
const WEBCAM = cam("ccc333", "Logitech StreamCam");

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A localStorage good enough for the storage module's needs. */
function stubStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

describe("resolveCamera", () => {
  const available = [FRONT, BACK, WEBCAM];

  it("returns null when nothing is remembered", () => {
    expect(resolveCamera(available, null)).toBeNull();
  });

  it("returns null when no cameras are attached", () => {
    expect(resolveCamera([], FRONT)).toBeNull();
  });

  it("matches on device id", () => {
    expect(resolveCamera(available, cam("bbb222", "Back Camera"))).toEqual(BACK);
  });

  it("falls back to the label when the id has rotated", () => {
    // What happens after site data is cleared: same camera, new id.
    expect(resolveCamera(available, cam("stale-id", "Logitech StreamCam"))).toEqual(WEBCAM);
  });

  it("prefers the id over the label when they disagree", () => {
    expect(resolveCamera(available, cam("aaa111", "Back Camera"))).toEqual(FRONT);
  });

  it("returns null when the camera is genuinely gone", () => {
    // A webcam that was unplugged: requesting it by exact id would fail, so
    // the caller has to know to fall back rather than ask for it anyway.
    expect(resolveCamera([FRONT, BACK], cam("ccc333", "Logitech StreamCam"))).toBeNull();
  });

  it("does not match a blank label against an unlabelled device", () => {
    expect(resolveCamera([cam("xyz", "")], cam("other", ""))).toBeNull();
  });

  it("ignores surrounding whitespace in labels", () => {
    expect(resolveCamera([cam("new-id", " Front Camera ")], cam("old", "Front Camera"))).toEqual({
      deviceId: "new-id",
      label: " Front Camera ",
    });
  });
});

describe("describeCamera", () => {
  it("uses the label when there is one", () => {
    expect(describeCamera(FRONT, 0)).toBe("Front Camera");
  });

  it("numbers unlabelled cameras from one", () => {
    expect(describeCamera(cam("x", ""), 0)).toBe("Camera 1");
    expect(describeCamera(cam("y", "   "), 2)).toBe("Camera 3");
  });
});

describe("camera preference", () => {
  it("survives a round trip", () => {
    stubStorage();
    saveCameraPreference(BACK);
    expect(loadCameraPreference()).toEqual(BACK);
  });

  it("clears when set to null", () => {
    stubStorage();
    saveCameraPreference(BACK);
    saveCameraPreference(null);
    expect(loadCameraPreference()).toBeNull();
  });

  it("returns null rather than throwing when storage is unavailable", () => {
    // Safari in private mode, and any browser with site data blocked.
    expect(loadCameraPreference()).toBeNull();
    expect(() => saveCameraPreference(FRONT)).not.toThrow();
  });

  it("rejects stored junk", () => {
    const map = stubStorage();
    map.set("frosmo:camera", JSON.stringify({ nonsense: true }));
    expect(loadCameraPreference()).toBeNull();
  });

  it("tolerates a stored entry with no label", () => {
    const map = stubStorage();
    map.set("frosmo:camera", JSON.stringify({ deviceId: "abc" }));
    expect(loadCameraPreference()).toEqual({ deviceId: "abc", label: "" });
  });
});

describe("listCameras", () => {
  it("returns only video inputs", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "videoinput", deviceId: "aaa111", label: "Front Camera" },
          { kind: "audioinput", deviceId: "mic", label: "Microphone" },
          { kind: "videoinput", deviceId: "bbb222", label: "Back Camera" },
        ],
      },
    });
    expect(await listCameras()).toEqual([FRONT, BACK]);
  });

  it("returns nothing when the browser cannot enumerate", async () => {
    vi.stubGlobal("navigator", {});
    expect(await listCameras()).toEqual([]);
  });

  it("returns nothing rather than throwing when enumeration fails", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => {
          throw new Error("denied");
        },
      },
    });
    expect(await listCameras()).toEqual([]);
  });
});

describe("watchCameras", () => {
  it("subscribes and unsubscribes", () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type),
      },
    });

    const stop = watchCameras(() => undefined);
    expect(listeners.has("devicechange")).toBe(true);
    stop();
    expect(listeners.has("devicechange")).toBe(false);
  });

  it("is a no-op where devicechange is unsupported", () => {
    vi.stubGlobal("navigator", {});
    expect(() => watchCameras(() => undefined)()).not.toThrow();
  });
});
