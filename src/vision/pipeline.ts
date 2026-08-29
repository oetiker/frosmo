/**
 * The pipeline: camera frame in, one VisionState out, once per video frame.
 *
 * Games never touch the camera, the homography or a detector directly. They
 * declare what they need — occupancy, a physics field, ink, tokens, tiles — and
 * read the state. Two things fall out of that. Nothing unused is ever computed,
 * which is most of the frame budget on games that only want a mask. And the
 * detectors stay swappable: every stage below is a pure function over flat
 * typed arrays with no per-frame allocation, which is deliberately the shape a
 * WebAssembly export takes if any of them ever needs to become one.
 */

import type { Blob } from "./blobs.js";
import { createLabelScratch, labelBlobs, type LabelScratch } from "./blobs.js";
import type { Camera } from "./camera.js";
import { boardSize, boardToCamera, type Calibration } from "./calibration.js";
import { classifyColor, type TokenColor } from "./color.js";
import { IDENTITY_GAIN } from "./photometry.js";
import { simplify, traceContours, type Contour } from "./contour.js";
import { buildAtlas, DEFAULT_DIGITS, DEFAULT_LETTERS, type GlyphAtlas } from "./glyph.js";
import { InkDetector } from "./ink.js";
import { VideoCropSource } from "./native-crop.js";
import { blurToField, createMask, type Mask } from "./mask.js";
import { OccupancyDetector } from "./occupancy.js";
import { buildSampleTable, createRectifiedFrame, rectify, type BoardSize, type RectifiedFrame } from "./rectify.js";
import { detectTiles, glyphMinArea, type Tile } from "./tiles.js";

export interface VisionNeeds {
  /** The covered-pixel mask. Nearly everything wants this. */
  occupancy?: boolean;
  /** Blurred occupancy, for collision normals. */
  field?: boolean;
  /** Outlines of what is on the table, for crisp rendering. */
  contours?: boolean;
  /** Dark strokes on light paper. */
  ink?: boolean;
  /** Coloured pieces, classified. */
  tokens?: boolean;
  /** Printed letter and digit tiles, read. */
  tiles?: boolean;
  /**
   * The characters this game actually uses.
   *
   * The same argument as `palette`, and the same evidence. Matched against all
   * twenty-six letters and ten digits at once, a printed D competes with 0 and
   * an A with 4 — and loses, while digits, having only nine rivals, read well.
   * Three of the first four misreadings observed on a real sheet were a letter
   * mistaken for a digit; the one that was correct, F, is the one with no digit
   * that resembles it. A spelling game never needs digits, so it should not be
   * made to argue with them.
   */
  alphabet?: string;
  /**
   * The colours this game actually uses.
   *
   * Not a filter applied afterwards — the classifier is restricted to these,
   * which is a different and much stronger thing. Left open, every sample
   * competes against all eight buckets, and neighbours steal the margin from
   * the colours that matter: a printed green photographs at about 145 degrees,
   * squarely between the green and cyan centres, and comes out correctly
   * identified but too uncertain to trust. Naming the four colours in play
   * removes the competition that was never real.
   */
  palette?: TokenColor[];
}

export interface Token {
  blob: Blob;
  color: TokenColor;
  confidence: number;
  cx: number;
  cy: number;
  area: number;
}

export interface VisionState {
  frame: RectifiedFrame;
  board: BoardSize;
  /** Anything on the table. */
  occupancy: Mask;
  /** occupancy plus ink, the geometry physics collides with. */
  solid: Mask;
  ink: Mask;
  field: Float32Array;
  blobs: Blob[];
  tokens: Token[];
  tiles: Tile[];
  contours: Contour[];
  coveredPixels: number;
  timings: Timings;
  /** False until the empty-board reference has been taken. */
  ready: boolean;
}

export interface Timings {
  capture: number;
  rectify: number;
  occupancy: number;
  ink: number;
  blobs: number;
  tiles: number;
  contours: number;
  total: number;
}

export interface PipelineOptions {
  /** Fraction of the native camera resolution to read back each frame. */
  captureScale?: number;
  /** Characters the tile detector may report. */
  alphabet?: string;
}

export class VisionPipeline {
  private cal: Calibration | null = null;
  private board: BoardSize = { w: 0, h: 0 };
  private frame: RectifiedFrame | null = null;
  private table: Int32Array | null = null;
  private tableFor = { w: 0, h: 0 };
  private occupancy: OccupancyDetector | null = null;
  private inkDetector: InkDetector | null = null;
  private solid: Mask | null = null;
  private field: Float32Array | null = null;
  /** Working buffers for the stages that need one, allocated with the board. */
  private blurScratch: Float32Array | null = null;
  private labelScratch: LabelScratch | null = null;
  private contourScratch: Uint8Array | null = null;
  private readonly atlases = new Map<string, GlyphAtlas>();
  private cropSource: VideoCropSource | null = null;
  private cropSourceFor = { w: 0, h: 0 };
  private needs: VisionNeeds = { occupancy: true };
  private learning = 0;
  private state: VisionState | null = null;
  private readonly captureScale: number;
  private readonly alphabet: string;

  constructor(
    private readonly camera: Camera,
    opts: PipelineOptions = {},
  ) {
    this.captureScale = opts.captureScale ?? 0.5;
    this.alphabet = opts.alphabet ?? DEFAULT_LETTERS + DEFAULT_DIGITS;
  }

  setCalibration(cal: Calibration): void {
    this.cal = cal;
    const size = boardSize(cal);
    if (size.w !== this.board.w || size.h !== this.board.h) {
      this.board = size;
      this.frame = createRectifiedFrame(size);
      this.occupancy = new OccupancyDetector(size.w, size.h);
      this.inkDetector = new InkDetector(size.w, size.h);
      this.solid = createMask(size.w, size.h);
      this.field = new Float32Array(size.w * size.h);
      this.blurScratch = new Float32Array(size.w * size.h);
      this.labelScratch = createLabelScratch(size.w, size.h);
      this.contourScratch = new Uint8Array((size.w + 1) * (size.h + 1));
      this.state = null;
    }
    // Force the gather table and the native crop source to be rebuilt against
    // the new corners.
    this.tableFor = { w: 0, h: 0 };
    this.cropSourceFor = { w: 0, h: 0 };
  }

  setNeeds(needs: VisionNeeds): void {
    this.needs = needs;
  }

  /** Discard the empty-board reference and take a new one over the next `frames` frames. */
  relearnBackground(frames = 12): void {
    this.occupancy?.forget();
    this.learning = frames;
  }

  /**
   * Throw the reference away without taking a new one.
   *
   * For when the frame itself has changed under us — a different camera, a
   * recalibration — and the next screen that wants the board will learn it
   * afresh. Keeping the old reference would be worse than having none: it
   * would produce confident, wrong detections.
   */
  forgetBackground(): void {
    this.occupancy?.forget();
    this.learning = 0;
  }

  get learningBackground(): boolean {
    return this.learning > 0;
  }

  get calibrated(): boolean {
    return this.occupancy?.calibrated ?? false;
  }

  get boardSizePx(): BoardSize {
    return this.board;
  }

  /**
   * The occupancy detector itself, for screens that tune or inspect it.
   *
   * Exposed deliberately: the thresholds that matter can only be judged under
   * a real mirror in a real room, so the vision lab adjusts them live on the
   * device rather than asking anyone to guess at them in a config file.
   */
  get occupancyDetector(): OccupancyDetector | null {
    return this.occupancy;
  }

  /** The atlas, built lazily because it needs a DOM canvas. */
  glyphAtlas(alphabet = this.alphabet): GlyphAtlas {
    // One atlas per alphabet, built once. Rendering thirty-six glyphs costs a
    // few milliseconds, and games switch alphabets only when they are entered.
    let atlas = this.atlases.get(alphabet);
    if (!atlas) {
      atlas = buildAtlas(alphabet);
      this.atlases.set(alphabet, atlas);
    }
    return atlas;
  }

  /** Process the current camera frame. Returns null until calibration and camera are both up. */
  step(time: number): VisionState | null {
    const { cal, frame, occupancy, inkDetector, solid, field } = this;
    if (!cal || !frame || !occupancy || !inkDetector || !solid || !field) return null;

    const t: Timings = {
      capture: 0,
      rectify: 0,
      occupancy: 0,
      ink: 0,
      blobs: 0,
      tiles: 0,
      contours: 0,
      total: 0,
    };
    const t0 = performance.now();

    const shot = this.camera.capture(this.captureScale);
    if (!shot) return null;
    t.capture = performance.now() - t0;

    if (!this.table || this.tableFor.w !== shot.w || this.tableFor.h !== shot.h) {
      this.table = buildSampleTable(boardToCamera(cal, shot.w, shot.h), this.board, shot.w, shot.h);
      this.tableFor = { w: shot.w, h: shot.h };
    }

    let mark = performance.now();
    rectify(shot.data, this.table, frame);
    frame.time = time;
    t.rectify = performance.now() - mark;

    if (this.learning > 0) {
      occupancy.learn(frame);
      this.learning--;
      // Nothing is reported while the reference is still being averaged. A
      // half-learned background yields blobs that are pure artefact, and a
      // game that acted on them would score the player for clearing the table.
      solid.data.fill(0);
      occupancy.mask.data.fill(0);
      this.state = {
        frame,
        board: this.board,
        occupancy: occupancy.mask,
        solid,
        ink: inkDetector.mask,
        field,
        blobs: [],
        tokens: [],
        tiles: [],
        contours: [],
        coveredPixels: 0,
        timings: t,
        ready: false,
      };
      return this.state;
    }

    mark = performance.now();
    let covered = 0;
    if (this.needs.occupancy !== false) covered = occupancy.detect(frame);
    t.occupancy = performance.now() - mark;

    mark = performance.now();
    // Tiles are read from ink, so asking for tiles asks for ink.
    const wantInk = Boolean(this.needs.ink || this.needs.tiles);
    if (wantInk) inkDetector.detect(frame.gray);
    t.ink = performance.now() - mark;

    // The union is what a ball bounces off: a drawn line and a wooden block are
    // the same obstacle as far as the physics is concerned.
    if (wantInk) {
      const a = occupancy.mask.data;
      const b = inkDetector.mask.data;
      const s = solid.data;
      for (let i = 0; i < s.length; i++) s[i] = a[i] | b[i];
    } else {
      solid.data.set(occupancy.mask.data);
    }

    if (this.needs.field) blurToField(solid, field, 2, this.blurScratch ?? undefined);

    mark = performance.now();
    let blobs: Blob[] = [];
    let tokens: Token[] = [];
    if (this.needs.tokens) {
      const result = labelBlobs(occupancy.mask, {
        rgba: frame.rgba,
        minArea: Math.round(this.board.w * this.board.h * 0.0008),
        limit: 32,
        scratch: this.labelScratch ?? undefined,
      });
      blobs = result.blobs;
      if (this.needs.tokens) {
        // Colour is judged after the exposure correction, not before: the
        // whole point of that correction is that raw pixel values are a
        // statement about the light as much as about the paint.
        const gain = this.occupancy?.gain ?? IDENTITY_GAIN;
        const palette = this.needs.palette;
        tokens = blobs.map((blob) => {
          const match = classifyColor(
            Math.min(255, blob.r * gain.r),
            Math.min(255, blob.g * gain.g),
            Math.min(255, blob.b * gain.b),
            palette ? { palette } : {},
          );
          return {
            blob,
            color: match.color,
            confidence: match.confidence,
            cx: blob.cx,
            cy: blob.cy,
            area: blob.area,
          };
        });
      }
    }
    t.blobs = performance.now() - mark;

    mark = performance.now();
    // Glyphs are labelled from the ink mask, with their own minimum area.
    //
    // Not from occupancy, and not with the token minimum. A printed tile on a
    // white sheet is not an object on the table — occupancy sees only the
    // colour discs there, and handing those to the recogniser is why every tile
    // used to read as "M". And the general blob minimum is tuned for tokens:
    // several times too large for a letter, which would discard most of them
    // before they were ever looked at.
    const tiles = this.needs.tiles
      ? detectTiles(
          frame,
          labelBlobs(inkDetector.mask, {
            minArea: glyphMinArea(this.board.w, this.board.h),
            limit: 96,
            scratch: this.labelScratch ?? undefined,
          }).blobs,
          this.glyphAtlas(this.needs.alphabet ?? this.alphabet),
          { source: this.tileCropSource(cal) ?? undefined },
        )
      : [];
    t.tiles = performance.now() - mark;

    mark = performance.now();
    const contours = this.needs.contours
      ? traceContours(solid, 10, this.contourScratch ?? undefined).map((c) => simplify(c, 1.2))
      : [];
    t.contours = performance.now() - mark;

    t.total = performance.now() - t0;

    this.state = {
      frame,
      board: this.board,
      occupancy: occupancy.mask,
      solid,
      ink: inkDetector.mask,
      field,
      blobs,
      tokens,
      tiles,
      contours,
      coveredPixels: covered,
      timings: t,
      ready: occupancy.calibrated,
    };
    return this.state;
  }

  /**
   * A crop source bound to the camera's *native* resolution.
   *
   * Rebuilt when the video's dimensions change, which happens once at startup
   * and again if the camera is switched — not per frame.
   */
  private tileCropSource(cal: Calibration): VideoCropSource | null {
    const { w, h } = this.camera.size;
    if (!w || !h) return null;
    if (!this.cropSource || this.cropSourceFor.w !== w || this.cropSourceFor.h !== h) {
      this.cropSource = new VideoCropSource(this.camera.element, boardToCamera(cal, w, h), this.board);
      this.cropSourceFor = { w, h };
    }
    return this.cropSource;
  }

  latest(): VisionState | null {
    return this.state;
  }

  /** The learned empty board, for the debug view. */
  backgroundRgba(out: Uint8ClampedArray): void {
    this.occupancy?.backgroundRgba(out);
  }
}
