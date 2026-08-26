/**
 * End-to-end smoke test against a synthetic mirror, served the way it deploys.
 *
 * Unit tests cover the maths; this covers the parts that only exist in a
 * browser — getUserMedia, the video readback, canvas rendering, the screens —
 * by feeding Chromium a fake camera showing a trapezoidal play area with pieces
 * on it, and checking the app finds them.
 *
 *   npm run build && npm run smoke
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { QUAD, writeClip } from "./make-fake-camera.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const OUT = process.env.SMOKE_OUT ?? join(ROOT, ".smoke");
const CLIP = join(OUT, "fake-camera.y4m");
const PORT = 4319;
/**
 * Served from a sub-path on purpose.
 *
 * GitHub Pages project sites live at /<repo>/, so every asset, the manifest,
 * the icons and the service worker have to resolve relatively. Serving at the
 * root would pass with an absolute base and then 404 on the real deployment.
 */
const BASE = "/frosmo/";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404).end("not found");
      return;
    }
    let file = join(DIST, decodeURIComponent(url.pathname.slice(BASE.length)));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(PORT, () => ok(server)));
}

/** The calibration the synthetic scene was drawn to match. */
const CALIBRATION = {
  version: 1,
  corners: QUAD,
  orientation: 0,
  aspect: 4 / 3,
  resolution: 256,
  createdAt: 1,
};

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("no dist/ — run `npm run build` first");
    process.exit(2);
  }

  mkdirSync(OUT, { recursive: true });
  if (!existsSync(CLIP)) {
    console.log("rendering the synthetic camera clip…");
    writeClip(CLIP);
  }

  const server = await serve();
  const browser = await chromium.launch({
    // Point at whatever Chromium this machine already has when it does not
    // match the Playwright build's expectation — CI images commonly pin one.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${CLIP}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    permissions: ["camera"],
    deviceScaleFactor: 2,
  });
  // Seed the calibration the synthetic scene was drawn to match — but only
  // when there is none. An init script runs on *every* navigation, so setting
  // it unconditionally would silently undo anything the app itself saves, and
  // any later check that depends on stored state would be testing this line
  // rather than the app.
  await context.addInitScript((cal) => {
    if (!localStorage.getItem("frosmo:calibration")) {
      localStorage.setItem("frosmo:calibration", JSON.stringify(cal));
    }
  }, CALIBRATION);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  try {
    await page.goto(`http://localhost:${PORT}${BASE}#home`);
    await page.waitForSelector(".card");
    check("menu lists every game", (await page.locator(".card").count()) === 4);
    await page.screenshot({ path: join(OUT, "1-home.png") });

    // --- the vision lab: does the pipeline see the table? ---------------
    await page.getByRole("button", { name: "Vision lab" }).click();
    await page.waitForSelector(".lab-canvas");
    await page.waitForFunction(() => {
      const el = document.querySelector(".lab-readout");
      return el && el.textContent.includes("covered");
    }, { timeout: 15000 });
    check("camera starts and the pipeline runs", true);

    // The clip alternates an empty table with pieces on it. Learning has to
    // happen during the empty stretch, so retry: a run that learns the pieces
    // into the background simply finds nothing and tries again.
    let readout = "";
    let learned = false;
    for (let attempt = 0; attempt < 6 && !learned; attempt++) {
      await page.getByRole("button", { name: "Relearn empty board" }).click();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        readout = await page.locator(".lab-readout").innerText();
        if (/blobs [3-9]/.test(readout) && !readout.includes("not learned")) {
          learned = true;
          break;
        }
        await page.waitForTimeout(150);
      }
    }

    check("finds the three pieces on the table", learned, readout.replace(/\n/g, " · "));
    check(
      "reads their colours through the mirror",
      /red/.test(readout) && /green/.test(readout) && /blue/.test(readout),
      readout.match(/tokens [^\n]*/)?.[0] ?? "no tokens line",
    );

    const timings = await page.locator(".lab-timings").innerText();
    console.log(`\n${timings.split("\n").map((l) => `        ${l}`).join("\n")}\n`);
    const total = Number(timings.match(/total\s+([\d.]+) ms/)?.[1] ?? NaN);
    // A ceiling, not a benchmark: headless Chromium rasterises in software and
    // coarsens performance.now(), so the absolute numbers here mean little.
    // `npx vite-node tools/bench.ts` measures the code itself. This catches a
    // regression that makes the loop unplayable, e.g. a per-frame allocation
    // storm or an accidental full-resolution pass.
    const budget = Number(process.env.SMOKE_BUDGET_MS ?? 60);
    check("pipeline stays inside its ceiling", total < budget, `total ${total} ms of ${budget} ms, every detector on`);
    await page.screenshot({ path: join(OUT, "2-lab.png") });

    // --- rectification: is the trapezoid actually straightened? ---------
    const straight = await page.evaluate(() => {
      const canvas = document.querySelectorAll(".lab-canvas")[0];
      const ctx = canvas.getContext("2d");
      const { width: w, height: h } = canvas;
      // The table fills the rectified board edge to edge. Sample the four
      // corners: if the homography were wrong, at least one would be the dark
      // room outside the play area rather than the table surface.
      const corners = [
        [4, 4],
        [w - 5, 4],
        [4, h - 5],
        [w - 5, h - 5],
      ].map(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return (d[0] + d[1] + d[2]) / 3;
      });
      return { corners, min: Math.min(...corners) };
    });
    check(
      "rectifies the trapezoid to fill the board",
      straight.min > 120,
      `corner luma ${straight.corners.map((c) => Math.round(c)).join(", ")}`,
    );

    // --- the games actually play ----------------------------------------
    // Spell It is left out here: the synthetic scene has no printed tiles, and
    // that path is covered by test/tiles.test.ts instead.
    const playable = [
      ["Silhouette", "occupancy"],
      ["Bounce", "physics against the table"],
      ["Colour Rush", "colour tokens"],
    ];

    for (const [name, what] of playable) {
      await page.goto(`http://localhost:${PORT}${BASE}#home`);
      await page.getByRole("button", { name: new RegExp(name) }).click();
      await page.waitForSelector(".play-canvas");
      // Long enough for Bounce to spawn its first ball on its own.
      await page.waitForTimeout(3200);

      const painted = await page.evaluate(() => {
        const canvas = document.querySelector(".play-canvas");
        const ctx = canvas.getContext("2d");
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let lit = 0;
        for (let i = 0; i < data.length; i += 4 * 97) {
          if (data[i] + data[i + 1] + data[i + 2] > 90) lit++;
        }
        return lit;
      });
      check(`${name} renders a live board (${what})`, painted > 100, `${painted} lit samples`);
      check(
        `${name} tells the player what to do`,
        (await page.locator(".hud-detail").innerText()).length > 0,
      );
      await page.screenshot({ path: join(OUT, `3-play-${name.toLowerCase().replace(/\s+/g, "-")}.png`) });
    }

    // --- calibration screen loads its live preview -----------------------
    await page.goto(`http://localhost:${PORT}${BASE}#calibrate`);
    await page.waitForSelector(".cal-overlay");
    await page.waitForTimeout(1500);
    const previewLive = await page.evaluate(() => {
      const canvas = document.querySelector(".cal-preview");
      const d = canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return (d[0] + d[1] + d[2]) / 3;
    });
    check("calibration preview shows the rectified table", previewLive > 120, `luma ${Math.round(previewLive)}`);
    await page.screenshot({ path: join(OUT, "4-calibrate.png") });

    // The camera picker only has anything to show once a stream is running,
    // because device labels stay blank until permission is granted.
    const picker = await page.locator(".cal-camera").innerText();
    check("the camera picker is populated once the stream is up", picker.trim().length > 0, picker.trim());

    // Dragging a corner must store a position relative to the camera *frame*,
    // not to the element the frame is letterboxed inside. The two agree only
    // when the stage happens to match the camera's aspect ratio, so this drags
    // a handle on a deliberately mismatched stage and reads back what was
    // stored.
    const geometry = await page.evaluate(() => {
      const stage = document.querySelector(".cal-overlay").getBoundingClientRect();
      const video = document.querySelector(".cal-video");
      return {
        stage: { x: stage.x, y: stage.y, w: stage.width, h: stage.height },
        video: { w: video.videoWidth, h: video.videoHeight },
      };
    });

    const aspect = geometry.video.w / geometry.video.h;
    const scale = Math.min(geometry.stage.w / aspect, geometry.stage.h);
    const content = {
      x: (geometry.stage.w - aspect * scale) / 2,
      y: (geometry.stage.h - scale) / 2,
      w: aspect * scale,
      h: scale,
    };
    check(
      "the preview is letterboxed, so the mapping is actually under test",
      content.x > 1 || content.y > 1,
      `bars ${Math.round(content.x)}px x ${Math.round(content.y)}px`,
    );

    const handleFrom = CALIBRATION.corners[0];
    const from = {
      x: geometry.stage.x + content.x + handleFrom.x * content.w,
      y: geometry.stage.y + content.y + handleFrom.y * content.h,
    };
    const to = { x: geometry.stage.x + geometry.stage.w * 0.3, y: geometry.stage.y + geometry.stage.h * 0.3 };
    const expected = {
      x: (to.x - geometry.stage.x - content.x) / content.w,
      y: (to.y - geometry.stage.y - content.y) / content.h,
    };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.getByRole("button", { name: /Learn empty board/ }).click();
    await page.waitForTimeout(300);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("frosmo:calibration")));
    const corner = stored.corners[0];
    const off = Math.hypot(corner.x - expected.x, corner.y - expected.y);
    check(
      "a dragged corner is stored in frame coordinates",
      off < 0.02,
      `stored (${corner.x.toFixed(3)}, ${corner.y.toFixed(3)}), expected (${expected.x.toFixed(3)}, ${expected.y.toFixed(3)})`,
    );
    check(
      "the calibration records which camera made it",
      typeof stored.cameraId === "string" && stored.cameraId.length > 0,
      stored.cameraId ? `cameraId ${String(stored.cameraId).slice(0, 12)}…` : "not recorded",
    );

    // --- a board calibrated with another camera is refused ----------------
    // Corners are only meaningful in the frame they were marked in, so a game
    // must stop rather than react to the wrong part of the world.
    await page.evaluate(() => {
      const cal = JSON.parse(localStorage.getItem("frosmo:calibration"));
      cal.cameraId = "a-camera-that-is-not-attached";
      localStorage.setItem("frosmo:calibration", JSON.stringify(cal));
    });
    await page.goto(`http://localhost:${PORT}${BASE}#play/silhouette`);
    // A reload, not just a hash change: the running app holds the calibration
    // in memory, so editing storage under it proves nothing without one.
    await page.reload();
    // Wait for the refusal specifically. The "clear the play area" overlay
    // appears synchronously on mount, while the camera check can only run once
    // the stream is up — reading the overlay before then just races it.
    await page.waitForSelector(".play-overlay button", { timeout: 15000 }).catch(() => undefined);
    const refusal = await page.locator(".play-overlay").innerText();
    check(
      "a game refuses a board calibrated with a different camera",
      /different camera/i.test(refusal),
      refusal.replace(/\n/g, " · "),
    );
    check(
      "and offers the way out",
      (await page.locator(".play-overlay button").count()) === 1,
    );

    // --- deployable as a static site under a sub-path --------------------
    const registration = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? { scope: reg.scope, active: Boolean(reg.active || reg.installing || reg.waiting) } : null;
    });
    check(
      "the service worker registers under the sub-path",
      Boolean(registration?.active) && registration.scope.endsWith(BASE),
      registration ? registration.scope : "no registration",
    );

    const assets = await page.evaluate(async (base) => {
      const manifestHref = document.querySelector('link[rel=manifest]').href;
      const manifest = await fetch(manifestHref).then((r) => (r.ok ? r.json() : null));
      if (!manifest) return { manifest: false };
      const icons = await Promise.all(
        manifest.icons.map(async (icon) => {
          const url = new URL(icon.src, manifestHref);
          const res = await fetch(url);
          return { url: url.pathname, ok: res.ok, type: res.headers.get("content-type") };
        }),
      );
      const apple = document.querySelector('link[rel="apple-touch-icon"]').href;
      const appleOk = (await fetch(apple)).ok;
      return {
        manifest: true,
        underBase: new URL(manifestHref).pathname.startsWith(base),
        start: new URL(manifest.start_url, manifestHref).pathname,
        icons,
        appleOk,
      };
    }, BASE);

    check("the manifest resolves relative to the deployment", assets.manifest && assets.underBase);
    check(
      "the install icons resolve",
      assets.icons?.every((i) => i.ok) && assets.appleOk,
      assets.icons?.map((i) => `${i.url} ${i.ok ? "ok" : "MISSING"}`).join(", "),
    );
    check(
      "start_url points at the deployment, not the domain root",
      assets.start === BASE,
      assets.start,
    );

    check("no console errors anywhere", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures.length ? `\n${failures.length} failed` : "\nall good");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
