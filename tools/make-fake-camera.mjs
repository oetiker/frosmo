/**
 * Synthesise what the mirror sees, as a Y4M clip Chromium can be fed as a
 * fake camera.
 *
 * The scene is the point: a play area drawn as a *trapezoid*, because that is
 * what a mirror looking down at a table actually delivers, with pieces whose
 * size and spacing change across the frame accordingly. A test against a
 * flat rectangle would pass with the homography removed entirely.
 *
 *   node tools/make-fake-camera.mjs [out.y4m]
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const W = 640;
const H = 480;
const FPS = 15;
/** Long enough that a background-learning pass reliably lands inside it. */
const EMPTY_SECONDS = 5;
const PIECES_SECONDS = 3;

/** The play area in the image: narrow at the far edge, wide at the near edge. */
export const QUAD = [
  { x: 0.27, y: 0.3 },
  { x: 0.73, y: 0.3 },
  { x: 0.96, y: 0.9 },
  { x: 0.04, y: 0.9 },
];

/** Pieces in board coordinates (0..1 across, 0..0.75 down for a 4:3 board). */
const PIECES = [
  { u: 0.22, v: 0.3, r: 0.075, rgb: [205, 40, 40] },
  { u: 0.52, v: 0.35, r: 0.075, rgb: [40, 160, 60] },
  { u: 0.78, v: 0.28, r: 0.075, rgb: [45, 85, 205] },
];

/** A drawn line across the near half of the board, for the ink detector. */
const STROKE = { v: 0.58, thickness: 0.035, rgb: [28, 28, 34] };

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Board space to image space, by bilinear interpolation of the quad's corners. */
function boardToImage(u, v) {
  const top = { x: lerp(QUAD[0].x, QUAD[1].x, u), y: lerp(QUAD[0].y, QUAD[1].y, u) };
  const bottom = { x: lerp(QUAD[3].x, QUAD[2].x, u), y: lerp(QUAD[3].y, QUAD[2].y, u) };
  return { x: lerp(top.x, bottom.x, v) * W, y: lerp(top.y, bottom.y, v) * H };
}

function renderFrame(withPieces) {
  const rgb = new Uint8Array(W * H * 3);
  // Dark surround: outside the play area is the room, not the table.
  for (let i = 0; i < W * H; i++) {
    rgb[i * 3] = 24;
    rgb[i * 3 + 1] = 26;
    rgb[i * 3 + 2] = 30;
  }

  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (Math.round(y) * W + Math.round(x)) * 3;
    rgb[o] = c[0];
    rgb[o + 1] = c[1];
    rgb[o + 2] = c[2];
  };

  // Paint the table by walking board space, so the trapezoid is filled exactly.
  const steps = 1400;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const u = i / steps;
      const v = j / steps;
      const p = boardToImage(u, v);
      let colour = [214, 210, 200];

      if (withPieces) {
        for (const piece of PIECES) {
          const du = u - piece.u;
          const dv = (v - piece.v) * 0.75;
          if (du * du + dv * dv <= piece.r * piece.r) colour = piece.rgb;
        }
        if (Math.abs(v - STROKE.v) < STROKE.thickness / 2 && u > 0.1 && u < 0.9) {
          colour = STROKE.rgb;
        }
      }

      put(p.x, p.y, colour);
      // The board-space walk leaves gaps where the image stretches; fill the
      // neighbour to the right and below rather than supersampling further.
      put(p.x + 1, p.y, colour);
      put(p.x, p.y + 1, colour);
    }
  }

  return rgb;
}

/** Rec. 601 RGB to planar YUV 4:2:0, which is what Y4M carries. */
function toYuv420(rgb) {
  const y = Buffer.alloc(W * H);
  const u = Buffer.alloc((W / 2) * (H / 2));
  const v = Buffer.alloc((W / 2) * (H / 2));

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const o = (py * W + px) * 3;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];
      y[py * W + px] = clamp(0.257 * r + 0.504 * g + 0.098 * b + 16);
      if (py % 2 === 0 && px % 2 === 0) {
        const i = (py / 2) * (W / 2) + px / 2;
        u[i] = clamp(-0.148 * r - 0.291 * g + 0.439 * b + 128);
        v[i] = clamp(0.439 * r - 0.368 * g - 0.071 * b + 128);
      }
    }
  }
  return Buffer.concat([y, u, v]);
}

function clamp(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function writeClip(out) {
  const empty = toYuv420(renderFrame(false));
  const pieces = toYuv420(renderFrame(true));
  const frameHeader = Buffer.from("FRAME\n", "ascii");

  const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420\n`, "ascii")];
  for (let i = 0; i < EMPTY_SECONDS * FPS; i++) chunks.push(frameHeader, empty);
  for (let i = 0; i < PIECES_SECONDS * FPS; i++) chunks.push(frameHeader, pieces);

  writeFileSync(out, Buffer.concat(chunks));
  return { width: W, height: H, fps: FPS, emptySeconds: EMPTY_SECONDS, piecesSeconds: PIECES_SECONDS };
}

// Importable for its QUAD and writeClip; only writes a file when run directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = process.argv[2] ?? "fake-camera.y4m";
  const info = writeClip(out);
  console.log(
    `${out}: ${info.width}x${info.height} @${info.fps}fps, ${info.emptySeconds}s empty then ${info.piecesSeconds}s with pieces`,
  );
}
