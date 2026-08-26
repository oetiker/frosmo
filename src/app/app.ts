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
import { VisionPipeline } from "../vision/pipeline.js";

export interface Screen {
  mount(app: App, root: HTMLElement): void;
  unmount?(): void;
}

export type ScreenName = "home" | "calibrate" | "play" | "lab" | "print" | "about";

export class App {
  readonly camera = new Camera();
  readonly pipeline = new VisionPipeline(this.camera);
  readonly audio = new Audio();
  calibration: Calibration | null = loadCalibration();
  /** Set when a screen wants the camera; released when nothing does. */
  private cameraUsers = 0;
  private current: Screen | null = null;
  private currentName: ScreenName | null = null;
  private currentArg: string | undefined;
  private factories = new Map<ScreenName, (arg?: string) => Screen>();

  constructor(private readonly root: HTMLElement) {
    if (this.calibration) this.pipeline.setCalibration(this.calibration);
    this.camera.onTrackLost(() => this.handleCameraLost());
    // iPadOS suspends the capture when the app goes to the background and
    // sometimes never resumes it; re-acquire on return rather than showing a
    // frozen frame.
    // Fragment navigation — the browser's back button, or a deep link pasted
    // into an already-open tab — changes the hash without reloading. Without
    // this the app silently stays where it is.
    window.addEventListener("hashchange", () => {
      const { name, arg } = this.parseHash();
      if (name && (name !== this.currentName || arg !== this.currentArg)) this.go(name, arg);
    });
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
    await this.camera.start({ facingMode: "user", width: 1280, height: 720 });
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
