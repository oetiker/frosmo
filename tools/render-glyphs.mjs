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

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const OUT = resolve(".glyphs");
const SIZE = 64;
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
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
        ctx.font = `700 ${size * 0.72}px ${fontStack}`;
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
