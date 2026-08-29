/**
 * Replay a captured diagnostic through the current detectors.
 *
 * The device is the only place these detectors can be judged, and a capture is
 * the closest thing to bringing the device here. This runs the real code, in a
 * real browser, over the pixels a real rig produced.
 *
 *   node tools/replay.mjs <diagnostic.json> [--board] [--alphabet ABC]
 *
 * --board replays with crops taken from the small rectified board, the way the
 * detector worked before native-resolution crops, for comparison.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/replay.mjs <diagnostic.json> [--board]");
  process.exit(2);
}

const native = !process.argv.includes("--board");
const alphabetFlag = process.argv.indexOf("--alphabet");
const alphabet =
  alphabetFlag > 0 ? process.argv[alphabetFlag + 1] : "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const OUT = process.env.REPLAY_OUT ?? resolve(".replay");
const PORT = 5178;

const bundle = JSON.parse(readFileSync(file, "utf8"));

// The dev server transforms the TypeScript sources on demand, so the replay
// runs the same modules the app does, with no build step in between.
const own = !process.env.REPLAY_SERVER;
const vite = own
  ? spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
  : null;

if (vite) {
  await new Promise((ok, fail) => {
    let log = "";
    const timer = setTimeout(() => fail(new Error(`vite did not start:\n${log}`)), 30000);
    const watch = (d) => {
      log += d;
      if (log.includes("Local:")) {
        clearTimeout(timer);
        setTimeout(ok, 500);
      }
    };
    vite.stdout.on("data", watch);
    vite.stderr.on("data", watch);
  });
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("console:", m.text());
  });
  await page.goto(`http://localhost:${PORT}/tools/replay.html`);
  await page.waitForFunction(() => window.replayReady);

  const result = await page.evaluate(
    ([b, o]) => window.replay(b, o),
    [bundle, { native, alphabet }],
  );

  mkdirSync(OUT, { recursive: true });
  result.crops.forEach((dataUrl, i) => {
    writeFileSync(join(OUT, `crop-${i}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
  });

  console.log(`\ncrops from: ${native ? "native camera resolution" : "the rectified board"}`);
  console.log(`board ${result.board.w}x${result.board.h}   exposure gain ${JSON.stringify(result.gain)}`);
  console.log(`covered ${(result.coveredFraction * 100).toFixed(1)}%   blobs ${result.blobs}`);

  const counts = {};
  for (const t of result.tokens) counts[t.color] = (counts[t.color] ?? 0) + 1;
  console.log(`tokens: ${JSON.stringify(counts)}`);

  console.log(`\ntiles read (${result.tiles.length}):`);
  for (const t of result.tiles) {
    console.log(`  ${t.char}   score ${t.score}  margin ${t.margin}  size ${t.size}`);
  }
  console.log(`\n${result.crops.length} crops written to ${OUT}/`);
} finally {
  await browser.close();
  vite?.kill();
}
