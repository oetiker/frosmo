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
import { createServer } from "node:net";
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

/**
 * A port the kernel just told us is free, rather than a fixed one.
 *
 * The first version pinned 5178 with --strictPort. Interrupt the tool once and
 * its vite child outlives it — nothing kills the server — and every later run
 * dies on "port already in use", thirty seconds after the fact. Asking for
 * port 0 and reading back what we got cannot collide with a previous run.
 */
const PORT = await freePort();

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const bundle = JSON.parse(readFileSync(file, "utf8"));

// The dev server transforms the TypeScript sources on demand, so the replay
// runs the same modules the app does, with no build step in between.
const own = !process.env.REPLAY_SERVER;
const vite = own
  ? spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
  : null;

// An interrupted run must not leave a server behind: without this the tool
// poisons its own next invocation.
const stopVite = () => {
  try {
    vite?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
};
process.on("exit", stopVite);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopVite();
    process.exit(130);
  });
}

if (vite) {
  await new Promise((ok, fail) => {
    let log = "";
    const timer = setTimeout(() => fail(new Error(`vite did not start:\n${log}`)), 30000);
    const done = (fn, arg) => {
      clearTimeout(timer);
      fn(arg);
    };
    const watch = (d) => {
      log += d;
      if (log.includes("Local:")) return void done(() => setTimeout(ok, 500));
      // Report a server that failed at once, rather than after the full
      // timeout: the error is already on screen and waiting adds nothing.
      if (/error when starting dev server|EADDRINUSE|already in use/i.test(log)) {
        done(fail, new Error(`vite failed to start:\n${log}`));
      }
    };
    vite.stdout.on("data", watch);
    vite.stderr.on("data", watch);
    vite.on("exit", (code) => done(fail, new Error(`vite exited (${code}):\n${log}`)));
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

  // page.evaluate has no timeout of its own, so a detector that loops would
  // hang this tool indefinitely with nothing on screen — which is exactly what
  // happened the first time it was pointed at a real capture.
  const result = await Promise.race([
    page.evaluate(([b, o]) => window.replay(b, o), [bundle, { native, alphabet }]),
    new Promise((_, fail) =>
      setTimeout(() => fail(new Error("replay did not finish within 120s")), 120000),
    ),
  ]);

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
