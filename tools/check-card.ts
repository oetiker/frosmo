/**
 * End-to-end check against the card the app actually draws.
 *
 * The unit tests raster the card from the same layout the detector reads,
 * which proves those two agree but nothing about the thing in between: the
 * SVG the print screen produces. This takes a screenshot of that SVG (see
 * shot-card.mjs), projects it into a frame the way a camera on a stand sees a
 * table, and runs the whole scan over the result.
 *
 * The projection is a real homography, built from four corners. An earlier
 * version of this file narrowed the far edge by scaling x with a factor linear
 * in y, which looks like perspective and is not one — a plane seen by a camera
 * foreshortens in *both* directions. The scan fitted a true homography through
 * the four marks, disagreed with the fake one everywhere between them, and read
 * the swatches off the wrong part of the card. The reading was wrong, the code
 * was right, and the harness was the thing at fault.
 *
 *   node tools/shot-card.mjs http://localhost:5173/ card.png
 *   python3 tools/png2rgba.py card.png card.rgba          # prints W H
 *   npx vite-node tools/check-card.ts card.rgba <W> <H> [tilt] [fill]
 */
import { readFileSync } from "node:fs";
import { scanCard } from "../src/vision/card-scan.js";
import { CARD_ASPECT, FIDUCIALS } from "../src/vision/card.js";
import { applyHomography, invertHomography, solveHomography, type Quad } from "../src/vision/homography.js";

const [pw, ph] = [Number(process.argv[3]), Number(process.argv[4])];
const shot = new Uint8ClampedArray(readFileSync(process.argv[2]));
const tilt = Number(process.argv[5] ?? 0.3);
const fill = Number(process.argv[6] ?? 0.62);

const W = 1280;
const H = 960;
const cardH = 1 / CARD_ASPECT;
const scale = Math.min(W * fill, (H * fill) / cardH);

/*
 * The card's four paper corners, as a camera on a stand sees them: the far
 * edge shorter and nearer the middle of the frame than the near one. Feeding
 * those to solveHomography gives the projection of the whole plane.
 */
const half = scale / 2;
const near = half;
const far = half * (1 - tilt);
const top = H / 2 - (cardH * scale) / 2 + (cardH * scale) * tilt * 0.25;
const paper: Quad = [
  { x: W / 2 - far, y: top },
  { x: W / 2 + far, y: top },
  { x: W / 2 + near, y: H / 2 + (cardH * scale) / 2 },
  { x: W / 2 - near, y: H / 2 + (cardH * scale) / 2 },
];
const cardToFrame = solveHomography(
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  paper,
);
const frameToCard = invertHomography(cardToFrame);

const frame = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  frame[i * 4] = frame[i * 4 + 1] = frame[i * 4 + 2] = 190; // a table, darker than paper
  frame[i * 4 + 3] = 255;
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const c = applyHomography(frameToCard, x + 0.5, y + 0.5);
    if (c.x < 0 || c.y < 0 || c.x >= 1 || c.y >= 1) continue;
    const si = (Math.floor(c.y * ph) * pw + Math.floor(c.x * pw)) * 4;
    const di = (y * W + x) * 4;
    frame[di] = shot[si];
    frame[di + 1] = shot[si + 1];
    frame[di + 2] = shot[si + 2];
  }
}

/*
 * A camera, roughly. Paper straight off a screenshot is 255 in every channel,
 * which no photograph of paper is, and which trips the card's own
 * "your lamp is clipping" warning every time. Pulling the exposure down and
 * putting a warm cast on it also gives the white balance something to undo.
 */
const exposure = Number(process.env.EXPOSURE ?? 0.9);
const tint = (process.env.TINT ?? "1.0,0.97,0.86").split(",").map(Number);
for (let i = 0; i < W * H; i++) {
  for (let c = 0; c < 3; c++) frame[i * 4 + c] = frame[i * 4 + c] * exposure * tint[c];
}

const seen = scanCard(frame, W, H);
if (!seen) {
  console.log("NO CARD FOUND");
  process.exit(1);
}
console.log("mirrored      ", seen.sighting.mirrored);
for (let i = 0; i < 4; i++) {
  const want = applyHomography(cardToFrame, FIDUCIALS[i].cx, FIDUCIALS[i].cy);
  const got = seen.sighting.quad[i];
  console.log(`  mark ${i}  off by ${Math.hypot(want.x - got.x, want.y - got.y).toFixed(1)} px`);
}
const p = seen.profile;
console.log("ink           ", p.ink.contrast.toFixed(3), "maxLuma", p.ink.maxLuma.toFixed(0));
console.log("blur          ", p.blur.toFixed(2), "px");
console.log("gain          ", p.gain.r.toFixed(3), p.gain.g.toFixed(3), p.gain.b.toFixed(3));
console.log("palette       ", p.palette.map((c) => `${c.name} ${c.rgb.map((v) => Math.round(v)).join(",")}`).join("  "));
console.log("warnings      ", p.warnings.length ? p.warnings : "none");
console.log("play area     ", Math.round(seen.calibration.playAreaMm!.w), "x",
  Math.round(seen.calibration.playAreaMm!.h), "mm  aspect", seen.calibration.aspect.toFixed(3));

if (process.env.DUMP) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.DUMP, Buffer.from(seen.card.rgba.buffer));
  console.log("rectified card", seen.card.size.w, "x", seen.card.size.h, "->", process.env.DUMP);
}
