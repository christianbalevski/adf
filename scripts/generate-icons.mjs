#!/usr/bin/env node
// Generates every app icon from resources/icons/icon.svg. Cross-platform:
// rasterises with sharp (librsvg) and writes .ico / .icns containers itself,
// so no macOS tools (sips/iconutil) are needed.
//
//   node scripts/generate-icons.mjs
//
// Outputs:
//   resources/icon.png                 1024, full-bleed (BrowserWindow icon)
//   resources/icons/png/<n>x<n>.png    16..1024, full-bleed (Linux)
//   resources/icons/win/icon.ico       16,24,32,48,64,128,256 (32-bit BMP)
//   resources/icons/mac/icon.icns      16..1024 PNG, Apple 824/1024 grid
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = join(root, 'resources')
const svg = readFileSync(join(res, 'icons/icon.svg'))

// Render straight from the vector at each size (no downscaling a 1024 bitmap).
const render = (size) =>
  sharp(svg, { density: Math.max(72, (72 * size) / 1024) * 4 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer()

// macOS: the tile sits in the Apple app-icon grid, an 824 body centred in a
// 1024 canvas (100 px transparent margin), so it matches neighbouring dock icons.
const renderMac = async (size) => {
  const body = Math.round((size * 824) / 1024)
  const pad = Math.floor((size - body) / 2)
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await render(body), left: pad, top: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

// ICO with 32-bit BGRA DIB entries (what the previous icon used; safest for NSIS).
async function ico(sizes) {
  const images = []
  for (const s of sizes) {
    const { data } = await sharp(await render(s)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0)
    header.writeInt32LE(s, 4)
    header.writeInt32LE(s * 2, 8) // XOR + AND mask height
    header.writeUInt16LE(1, 12)
    header.writeUInt16LE(32, 14)
    const xor = Buffer.alloc(s * s * 4)
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const src = (y * s + x) * 4
        const dst = ((s - 1 - y) * s + x) * 4 // bottom-up
        xor[dst] = data[src + 2]
        xor[dst + 1] = data[src + 1]
        xor[dst + 2] = data[src]
        xor[dst + 3] = data[src + 3]
      }
    }
    const maskRow = Math.ceil(s / 32) * 4
    const mask = Buffer.alloc(maskRow * s) // all 0: alpha channel governs
    images.push({ s, buf: Buffer.concat([header, xor, mask]) })
  }
  const dir = Buffer.alloc(6 + 16 * images.length)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(images.length, 4)
  let offset = dir.length
  images.forEach(({ s, buf }, i) => {
    const o = 6 + i * 16
    dir[o] = s >= 256 ? 0 : s
    dir[o + 1] = s >= 256 ? 0 : s
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([dir, ...images.map((i) => i.buf)])
}

// ICNS with PNG payloads (macOS 10.7+).
async function icns() {
  const types = [
    ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128],
    ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
  ]
  const chunks = []
  for (const [type, size] of types) {
    const png = await renderMac(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    chunks.push(head, png)
  }
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

const out = (rel, buf) => {
  const p = join(res, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, buf)
  console.log(`${rel}  ${buf.length} B`)
}

out('icon.png', await render(1024))
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) out(`icons/png/${s}x${s}.png`, await render(s))
out('icons/win/icon.ico', await ico([16, 24, 32, 48, 64, 128, 256]))
out('icons/mac/icon.icns', await icns())
