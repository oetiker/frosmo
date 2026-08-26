/**
 * Camera access, with the iPadOS-specific parts spelled out.
 *
 * Three things bite here and all three are handled below:
 *   - getUserMedia needs a secure context. Home-screen web apps have had
 *     working camera access since iOS 14.3; before that it silently failed.
 *   - Autoplay only works on a muted, `playsinline` element, and the stream
 *     must be started from a user gesture.
 *   - Backgrounding the app suspends and sometimes ends the video track. We
 *     watch for that and re-acquire on return.
 */

export interface CameraOptions {
  /** "user" for the front camera, which is the one the mirror rig folds down onto the table. */
  facingMode?: "user" | "environment";
  width?: number;
  height?: number;
  deviceId?: string;
}

export type CameraErrorKind =
  | "insecure-context"
  | "unsupported"
  | "denied"
  | "not-found"
  | "in-use"
  | "unknown";

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

const MESSAGES: Record<CameraErrorKind, string> = {
  "insecure-context":
    "The camera needs a secure connection. Open this app over HTTPS, or from localhost during development.",
  unsupported: "This browser does not expose a camera to web apps.",
  denied:
    "Camera access was refused. On iPadOS: Settings › Apps › Safari › Camera, or the ⓘ button in the address bar.",
  "not-found": "No camera was found on this device.",
  "in-use": "The camera is busy in another app. Close that app and try again.",
  unknown: "The camera could not be started.",
};

export function describeCameraError(e: unknown): string {
  if (e instanceof CameraError) return MESSAGES[e.kind];
  return MESSAGES.unknown;
}

function classify(e: unknown): CameraErrorKind {
  const name = (e as { name?: string } | undefined)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "not-found";
    case "NotReadableError":
    case "AbortError":
      return "in-use";
    default:
      return "unknown";
  }
}

/**
 * A running camera, wrapped so callers only deal with "give me the current
 * pixels" and never with element or track lifecycle.
 */
export class Camera {
  private stream: MediaStream | null = null;
  private readonly video: HTMLVideoElement;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private captureW = 0;
  private captureH = 0;
  private onLost: (() => void) | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("muted", "");
  }

  /** The element to show in a preview. Never appended by the camera itself. */
  get element(): HTMLVideoElement {
    return this.video;
  }

  get running(): boolean {
    return this.stream !== null && this.video.readyState >= 2;
  }

  /** Native capture size, or 0x0 before the first frame. */
  get size(): { w: number; h: number } {
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  /**
   * The device the running track actually came from.
   *
   * Asked of the track rather than remembered from the request, because a
   * constraint is a preference: ask for a device that has been unplugged and
   * the browser hands back a different one without complaint. Only the track
   * knows what is really on.
   */
  get activeDeviceId(): string | null {
    const track = this.stream?.getVideoTracks()[0];
    return track?.getSettings().deviceId ?? null;
  }

  get activeLabel(): string | null {
    return this.stream?.getVideoTracks()[0]?.label ?? null;
  }

  /** Called from a user gesture. Resolves once the first frame has real dimensions. */
  async start(opts: CameraOptions = {}): Promise<void> {
    if (this.stream) return;

    if (!globalThis.isSecureContext) {
      throw new CameraError("insecure-context", "getUserMedia requires a secure context");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError("unsupported", "mediaDevices.getUserMedia is missing");
    }

    const video: MediaTrackConstraints = {
      facingMode: opts.deviceId ? undefined : (opts.facingMode ?? "user"),
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      width: { ideal: opts.width ?? 1280 },
      height: { ideal: opts.height ?? 720 },
      frameRate: { ideal: 30 },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      throw new CameraError(classify(e), String(e));
    }

    this.video.srcObject = this.stream;
    for (const track of this.stream.getVideoTracks()) {
      track.addEventListener("ended", () => this.handleLost());
    }

    try {
      await this.video.play();
    } catch (e) {
      this.stop();
      throw new CameraError("unknown", `video.play() rejected: ${e}`);
    }

    await this.firstFrame();
  }

  private firstFrame(): Promise<void> {
    if (this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.video.removeEventListener("loadedmetadata", done);
        this.video.removeEventListener("resize", done);
        resolve();
      };
      this.video.addEventListener("loadedmetadata", done);
      this.video.addEventListener("resize", done);
    });
  }

  private handleLost(): void {
    this.stop();
    this.onLost?.();
  }

  /** Notified when iPadOS tears the track down — typically after backgrounding. */
  onTrackLost(fn: () => void): void {
    this.onLost = fn;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /**
   * Capture the current frame into an intermediate buffer and return its pixels.
   *
   * `scale` shrinks the capture: the rectified board is a few hundred pixels
   * across, so pulling 1280x720 through getImageData every frame is waste. Half
   * resolution keeps plenty of detail for the play area and cuts the readback
   * cost fourfold.
   */
  capture(scale = 0.5): { data: Uint8ClampedArray; w: number; h: number } | null {
    const { w: vw, h: vh } = this.size;
    if (!vw || !vh) return null;

    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (!this.ctx || this.captureW !== w || this.captureH !== h) {
      this.canvas = makeCanvas(w, h);
      this.ctx = this.canvas.getContext("2d", {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D;
      this.captureW = w;
      this.captureH = h;
    }

    const ctx = this.ctx!;
    ctx.drawImage(this.video, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Run `fn` once per video frame, preferring the frame callback so we never
 * process the same frame twice or miss one under load.
 */
export function onVideoFrame(video: HTMLVideoElement, fn: (time: number) => void): () => void {
  let stopped = false;

  const rvfc = (
    video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number;
    }
  ).requestVideoFrameCallback?.bind(video);

  if (rvfc) {
    const step = (now: number) => {
      if (stopped) return;
      fn(now);
      rvfc(step);
    };
    rvfc(step);
  } else {
    const step = (now: number) => {
      if (stopped) return;
      fn(now);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  return () => {
    stopped = true;
  };
}
