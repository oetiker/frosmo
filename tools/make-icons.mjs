/**
 * Generate the app icons.
 *
 * Written as code rather than committed as binaries: an icon that is four
 * shapes and two colours should be reviewable in a diff, and this keeps the
 * repository free of blobs nobody can inspect. Node's zlib does the only hard
 * part, so there is no image dependency to install.
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const BG = [13, 18, 32, 255];
const ACCENT = [125, 159, 232, 255];
const BALL = [246, 195, 68, 255];

/**
 * The mark: a trapezoid — the play area as the mirror actually delivers it,
 * narrow at the far edge — with a ball above it.
 */
function draw(size, { maskable }) {
  const px = new Uint8Array(size * size * 4);
  // A maskable icon is cropped to a circle inscribed in the safe zone, so the
  // artwork has to shrink and the background has to reach every corner.
  const pad = maskable ? size * 0.28 : size * 0.16;
  const radius = maskable ? 0 : size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = radius === 0 || insideRoundedRect(x, y, 0, 0, size, size, radius);
      set(px, size, x, y, inside ? BG : [0, 0, 0, 0]);
    }
  }

  const top = pad + (size - pad * 2) * 0.42;
  const bottom = size - pad;
  const halfTop = (size - pad * 2) * 0.22;
  const halfBottom = (size - pad * 2) * 0.46;
  const cx = size / 2;

  for (let y = Math.floor(top); y < bottom; y++) {
    const t = (y - top) / (bottom - top);
    const half = halfTop + (halfBottom - halfTop) * t;
    for (let x = Math.ceil(cx - half); x < cx + half; x++) {
      set(px, size, x, y, ACCENT);
    }
  }

  const ballR = (size - pad * 2) * 0.13;
  const ballY = pad + ballR * 1.3;
  for (let y = Math.floor(ballY - ballR); y <= ballY + ballR; y++) {
    for (let x = Math.floor(cx - ballR); x <= cx + ballR; x++) {
      if ((x - cx) ** 2 + (y - ballY) ** 2 <= ballR * ballR) set(px, size, x, y, BALL);
    }
  }

  return px;
}

function set(px, size, x, y, rgba) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const o = (y * size + x) * 4;
  px[o] = rgba[0];
  px[o + 1] = rgba[1];
  px[o + 2] = rgba[2];
  px[o + 3] = rgba[3];
}

function insideRoundedRect(x, y, rx, ry, w, h, r) {
  const nx = Math.max(rx + r - x, 0, x - (rx + w - r));
  const ny = Math.max(ry + r - y, 0, y - (ry + h - r));
  return nx * nx + ny * ny <= r * r;
}

// --- minimal PNG writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(px, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    // Filter type 0 per scanline: these icons are flat colour, so filtering
    // would buy a few hundred bytes for a good deal more code.
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });

for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, true],
]) {
  writeFileSync(resolve(OUT, name), encodePng(draw(size, { maskable }), size));
  console.log(`wrote icons/${name}`);
}
