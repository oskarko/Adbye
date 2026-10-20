#!/usr/bin/env node
// Draws the AdBye icons (a stop-sign octagon with a white bar) as PNGs with
// no image dependencies: 4x supersampled rasterizing plus a tiny PNG encoder.

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "extension", "icons");
const SIZES = [16, 32, 48, 128];
const VARIANTS = { "": [217, 48, 37], "-paused": [128, 134, 139] };
const SS = 4;

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Regular octagon centered in a unit square, flat sides on the axes.
function inOctagon(x, y, r) {
  const dx = Math.abs(x - 0.5);
  const dy = Math.abs(y - 0.5);
  return dx <= r && dy <= r && dx + dy <= r * Math.SQRT2;
}

function shade(x, y) {
  if (!inOctagon(x, y, 0.47)) return null;
  const bar = Math.abs(y - 0.5) <= 0.085 && Math.abs(x - 0.5) <= 0.29;
  return bar ? "white" : "fill";
}

function draw(size, color) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (!s) continue;
          const c = s === "white" ? [255, 255, 255] : color;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const i = (py * size + px) * 4;
      if (a) rgba.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / (SS * SS)) * 255)], i);
    }
  }
  return encodePng(size, rgba);
}

await fs.mkdir(OUT, { recursive: true });
for (const [suffix, color] of Object.entries(VARIANTS)) {
  for (const size of SIZES) {
    await fs.writeFile(path.join(OUT, `icon-${size}${suffix}.png`), draw(size, color));
  }
}
console.log(`Wrote ${SIZES.length * Object.keys(VARIANTS).length} icons to ${path.relative(process.cwd(), OUT)}`);
