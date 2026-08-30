/**
 * The shell: one camera, one pipeline, one screen at a time.
 *
 * Screens are plain objects with mount/unmount. The camera and the vision
 * pipeline outlive them, because acquiring a camera on iPadOS takes long enough
 * to be visible and tearing it down between the menu and a game would make
 * every transition feel broken.
 */

import { GAMES, findGame } from "../games/registry.js";
import { Audio } from "../util/audio.js";
import { clear } from "../util/dom.js";
import { loadCalibration, saveCalibration, type Calibration } from "../vision/calibration.js";
import { Camera } from "../vision/camera.js";
import {
  listCameras,
  loadCameraPreference,
  resolveCamera,
  saveCameraPreference,
  type CameraChoice,
} from "../vision/cameras.js";
import { VisionPipeline } from "../vision/pipeline.js";

export interface Screen {
  mount(app: App, root: HTMLElement): void;
  unmount?(): void;
}

export type ScreenName = "home" | "calibrate" | "play" | "lab" | "print" | "card" | "about";

export class App {
  readonly camera = new Camera();
  readonly pipeline = new VisionPipeline(this.camera);
  readonly audio = new Audio();
  calibration: Calibration | null = loadCalibration();
  /** The camera the player picked, if any; null means "let the browser choose". */
  preferredCamera: CameraChoice | null = loadCameraPreference();
  /** Video inputs seen the last time we could enumerate them. */
  cameras: CameraChoice[] = [];
  /** Set when a screen wants the camera; released when nothing does. */
  private cameraUsers = 0;
  private current: Screen | null = null;
  private currentName: ScreenName | null = null;
  private currentArg: string | undefined;
  private factories = new Map<ScreenName, (arg?: string) => Screen>();

  constructor(private readonly root: HTMLElement) {
    if (this.calibration) this.pipeline.setCalibration(this.calibration);
    this.camera.onTrackLost(() => this.handleCameraLost());
    // Fragment navigation — the browser's back button, or a deep link pasted
    // into an already-open tab — changes the hash without reloading. Without
    // this the app silently stays where it is.
    window.addEventListener("hashchange", () => {
      const { name, arg } = this.parseHash();
      if (name && (name !== this.currentName || arg !== this.currentArg)) this.go(name, arg);
    });
    // iPadOS suspends the capture when the app goes to the background and
    // sometimes never resumes it; re-acquire on return rather than showing a
    // frozen frame.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.cameraUsers > 0 && !this.camera.running) {
        void this.acquireCamera();
      }
    });
  }

  register(name: ScreenName, factory: (arg?: string) => Screen): void {
    this.factories.set(name, factory);
  }

  get games() {
    return GAMES;
  }

  game(id: string) {
    return findGame(id);
  }

  go(name: ScreenName, arg?: string): void {
    const factory = this.factories.get(name);
    if (!factory) return;

    this.current?.unmount?.();
    clear(this.root);
    this.currentName = name;
    this.currentArg = arg;
    this.current = factory(arg);
    this.current.mount(this, this.root);
    // The hash is for the browser's benefit — reload and deep links — not a
    // router: screens are created above, never from a hashchange.
    const hash = arg ? `#${name}/${arg}` : `#${name}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  get screenName(): ScreenName | null {
    return this.currentName;
  }

  setCalibration(cal: Calibration): void {
    this.calibration = cal;
    this.pipeline.setCalibration(cal);
    saveCalibration(cal);
  }

  /** Screens call this on mount and releaseCamera() on unmount. */
  async useCamera(): Promise<void> {
    this.cameraUsers++;
    if (!this.camera.running) await this.acquireCamera();
  }

  releaseCamera(): void {
    this.cameraUsers = Math.max(0, this.cameraUsers - 1);
    if (this.cameraUsers === 0) this.camera.stop();
  }

  private async acquireCamera(): Promise<void> {
    // A remembered choice is only a request: the device may have been
    // unplugged, or its id may have rotated. resolveCamera decides whether the
    // preference is still meaningful, and we fall back to the front camera —
    // the one a reflector sits over — when it is not.
    const resolved = resolveCamera(this.cameras, this.preferredCamera);
    await this.camera.start(
      resolved
        ? { deviceId: resolved.deviceId, width: 1280, height: 720 }
        : { facingMode: "user", width: 1280, height: 720 },
    );
    // Labels are blank until permission has been granted, so the list is only
    // worth reading once a stream is up. This is also why the picker lives on
    // a screen that has already started the camera.
    this.cameras = await listCameras();
  }

  /**
   * Switch to a different camera, and remember it.
   *
   * The stream is torn down and rebuilt rather than using applyConstraints:
   * changing the source device on a live track is not reliable across
   * browsers, and this path is already exercised on every backgrounding.
   */
  async selectCamera(choice: CameraChoice | null): Promise<void> {
    this.preferredCamera = choice;
    saveCameraPreference(choice);
    if (this.cameraUsers === 0) return;
    this.camera.stop();
    await this.acquireCamera();
  }

  /** Refresh the known device list; safe to call any time a stream is running. */
  async refreshCameras(): Promise<CameraChoice[]> {
    this.cameras = await listCameras();
    return this.cameras;
  }

  /**
   * Whether the running camera is the one the board was calibrated with.
   *
   * A calibration is four corners in *one camera's* frame. Point a different
   * camera at the table and those corners describe nothing, so this is worth
   * saying out loud rather than letting the games quietly mis-see the board.
   */
  cameraMatchesCalibration(): boolean {
    const calibratedTo = this.calibration?.cameraId;
    if (!calibratedTo) return true;
    const active = this.camera.activeDeviceId;
    if (!active) return true;
    return active === calibratedTo;
  }

  private handleCameraLost(): void {
    if (this.cameraUsers > 0 && document.visibilityState === "visible") {
      void this.acquireCamera().catch(() => {
        /* the screen's own error path will show this */
      });
    }
  }

  /** Where the app should start: calibration is a precondition for everything. */
  initialScreen(): { name: ScreenName; arg?: string } {
    if (!this.calibration) return { name: "calibrate" };
    const { name, arg } = this.parseHash();
    return name ? { name, arg } : { name: "home" };
  }

  private parseHash(): { name: ScreenName | null; arg?: string } {
    const [name, arg] = location.hash.replace(/^#/, "").split("/");
    return this.factories.has(name as ScreenName) ? { name: name as ScreenName, arg } : { name: null };
  }
}
