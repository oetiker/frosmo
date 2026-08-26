/**
 * Stage-by-stage cost of the pipeline, without a browser in the way.
 *
 *   npx vite-node tools/bench.ts [boardWidth]
 *
 * The browser smoke test measures the whole loop including the camera readback,
 * which is dominated by the machine's graphics stack. This measures only the
 * code we can actually make faster.
 */

import { createLabelScratch, labelBlobs } from "../src/vision/blobs.js";
import { simplify, traceContours } from "../src/vision/contour.js";
import { InkDetector } from "../src/vision/ink.js";
import { blurToField } from "../src/vision/mask.js";
import { OccupancyDetector } from "../src/vision/occupancy.js";
import { createRectifiedFrame } from "../src/vision/rectify.js";

const W = Number(process.argv[2] ?? 256);
const H = Math.round((W * 3) / 4);

const frame = createRectifiedFrame({ w: W, h: H });
const empty = createRectifiedFrame({ w: W, h: H });

function paint(target: typeof frame, withPieces: boolean) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c: [number, number, number] = [206, 202, 194];
      if (withPieces) {
        for (const [cx, cy, r, col] of PIECES) {
          if ((x - cx * W) ** 2 + (y - cy * H) ** 2 < (r * W) ** 2) c = col as [number, number, number];
        }
        if (Math.abs(y - H * 0.72) < H * 0.02) c = [30, 30, 36];
      }
      target.rgba[i * 4] = c[0];
      target.rgba[i * 4 + 1] = c[1];
      target.rgba[i * 4 + 2] = c[2];
      target.rgba[i * 4 + 3] = 255;
      target.gray[i] = (c[0] * 77 + c[1] * 150 + c[2] * 29) >> 8;
    }
  }
}

const PIECES = [
  [0.24, 0.34, 0.08, [200, 44, 44]],
  [0.52, 0.36, 0.08, [44, 160, 66]],
  [0.78, 0.32, 0.08, [48, 88, 200]],
] as const;

paint(empty, false);
paint(frame, true);

const occupancy = new OccupancyDetector(W, H);
for (let i = 0; i < 12; i++) occupancy.learn(empty);
const ink = new InkDetector(W, H);
const field = new Float32Array(W * H);
// The same reusable buffers the pipeline holds, so this measures the code as
// it actually runs rather than a version that allocates on every frame.
const blurScratch = new Float32Array(W * H);
const labelScratch = createLabelScratch(W, H);
const contourScratch = new Uint8Array((W + 1) * (H + 1));

function bench(name: string, fn: () => void, iterations = 200): number {
  for (let i = 0; i < 30; i++) fn(); // warm the JIT
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = (performance.now() - t0) / iterations;
  console.log(`  ${name.padEnd(14)} ${ms.toFixed(3)} ms`);
  return ms;
}

console.log(`board ${W}x${H} (${((W * H) / 1000).toFixed(0)}k px)\n`);
let total = 0;
total += bench("occupancy", () => occupancy.detect(frame));
total += bench("ink", () => ink.detect(frame.gray));
total += bench("field", () => blurToField(occupancy.mask, field, 2, blurScratch));
total += bench("blobs", () =>
  labelBlobs(occupancy.mask, { rgba: frame.rgba, minArea: 40, scratch: labelScratch }),
);
total += bench("contours", () =>
  traceContours(occupancy.mask, 10, contourScratch).map((c) => simplify(c, 1.2)),
);
console.log(`  ${"sum".padEnd(14)} ${total.toFixed(3)} ms\n`);
