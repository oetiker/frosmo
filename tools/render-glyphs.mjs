/**
 * Render the glyph set at high resolution, for training.
 *
 * Uses the app's own atlas renderer in a real browser, so the shapes the model
 * learns are the shapes the app draws — and, because the printable tile sheet
 * is set in the same typeface, the shapes a printed tile actually carries.
 * Training on anything else would teach the model a different alphabet from the
 * one it will be asked to read.
 *
 *   node tools/render-glyphs.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const OUT = resolve(".glyphs");
const SIZE = 64;
// Read from the app rather than repeated here: a renderer that disagrees with
// the alphabet trains the model to read a set the app never asks for.
const glyphSource = readFileSync(resolve("src/vision/glyph.ts"), "utf8");
const pick = (name) => glyphSource.match(new RegExp(`${name} = "([^"]+)"`))?.[1];
const CHARS = `${pick("DEFAULT_LETTERS")}${pick("DEFAULT_DIGITS")}`;
if (CHARS.length < 36) throw new Error(`could not read the alphabet from glyph.ts (got "${CHARS}")`);
// The same file the app ships, loaded into the page here: a renderer that used
// a system font would teach the model letterforms no printer will ever produce.
const FONT_FILE = resolve("src/assets/atkinson-next-500.woff2");
const FONT_B64 = readFileSync(FONT_FILE).toString("base64");
const FONT_STACK = '"Atkinson Hyperlegible Next"';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>@font-face{
    font-family:"Atkinson Hyperlegible Next";font-weight:500;font-style:normal;
    src:url(data:font/woff2;base64,${FONT_B64}) format("woff2")}</style>`);
  // Canvas draws with whatever is loaded at the time, silently falling back if
  // it is not — so wait, and then prove it arrived rather than assume it.
  await page.evaluate(async () => {
    await document.fonts.load('500 46px "Atkinson Hyperlegible Next"');
    await document.fonts.ready;
  });
  const loaded = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("2d");
    c.font = '500 46px "Atkinson Hyperlegible Next"';
    const mine = c.measureText("I").width;
    c.font = "500 46px monospace";
    return { mine, fallback: c.measureText("I").width };
  });
  if (!loaded.mine || Math.abs(loaded.mine - loaded.fallback) < 0.01) {
    throw new Error(
      `Atkinson Hyperlegible Next did not load; canvas would have drawn the fallback ` +
        `(I is ${loaded.mine}px either way). Refusing to render an atlas the app cannot match.`,
    );
  }

  const glyphs = await page.evaluate(
    ({ chars, size, fontStack }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const out = {};

      for (const ch of chars) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = "#000";
        // Weight varies between printers and papers, so the set covers a range
        // rather than one nominal weight.
        ctx.font = `500 ${size * 0.72}px ${fontStack}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(ch, size / 2, size / 2);

        const { data } = ctx.getImageData(0, 0, size, size);
        const gray = new Array(size * size);
        for (let i = 0; i < gray.length; i++) {
          const o = i * 4;
          gray[i] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
        }
        out[ch] = gray;
      }
      return out;
    },
    { chars: CHARS, size: SIZE, fontStack: FONT_STACK },
  );

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "base.json"), JSON.stringify({ size: SIZE, chars: CHARS, glyphs }));
  console.log(`rendered ${CHARS.length} glyphs at ${SIZE}x${SIZE} -> .glyphs/base.json`);
} finally {
  await browser.close();
}
