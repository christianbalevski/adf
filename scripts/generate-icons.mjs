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
//   resources/tray/trayTemplate[@2x].png  macOS menu bar, the bare .A mark
//   resources/icons/mac/AppIcon.icon   Icon Composer source, light + dark
//   resources/icons/mac/Assets.car     compiled from it (macOS + Xcode 26 only)
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
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

// macOS menu bar: the .A mark alone, as a template image. Template images are
// black + alpha only (macOS recolors them for light and dark menu bars), so
// the paper square goes and the blue dot turns black with the A. The viewBox
// crops to the mark: dot left edge to A right foot, apex to dot bottom.
const MARK_BOX = '0 -1490 1955.7 1506.8'
const markSvg = Buffer.from(
  svg.toString()
    .replace(/<rect[^>]*\/>/, '')
    .replace(/fill="#[0-9a-f]{6}"/gi, 'fill="#000000"')
    .replace(/viewBox="[^"]*"/, `viewBox="${MARK_BOX}"`)
    .replace(/ width="\d+" height="\d+"/, '')
)
// An 18x16pt slot with a 13pt-tall glyph, the size of the system's status icons.
const tray = async (scale) => {
  const [w, h] = [18 * scale, 16 * scale]
  const glyph = await sharp(markSvg, { density: 72 * 8 })
    .resize({ height: 13 * scale })
    .png()
    .toBuffer()
  const { width: gw } = await sharp(glyph).metadata()
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: glyph, left: Math.floor((w - gw) / 2), top: Math.floor((h - 13 * scale) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}
out('tray/trayTemplate.png', await tray(1))
out('tray/trayTemplate@2x.png', await tray(2))

// macOS 26 dark mode: an Icon Composer bundle whose fills switch per
// appearance (light = the icon.svg colours, dark = the dark brand tokens:
// paper #0c0e13, ink #eceef3, blue #7f9dff). Each layer is the mark element
// alone on the icon.svg canvas, so its position matches the .icns exactly.
const srgb = (hex) => 'srgb:' + [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(',') + ',1.00000'
const fills = (light, dark) => [
  { value: { solid: srgb(light) } },
  { appearance: 'dark', value: { solid: srgb(dark) } },
]
const source = svg.toString()
const svgOpen = source.match(/<svg[^>]*>/)[0]
const layer = (re) => Buffer.from(`${svgOpen}${source.match(re)[0]}</svg>\n`)
const iconDir = join(res, 'icons/mac/AppIcon.icon')
rmSync(iconDir, { recursive: true, force: true })
out('icons/mac/AppIcon.icon/Assets/a.svg', layer(/<path[^>]*\/>/))
out('icons/mac/AppIcon.icon/Assets/dot.svg', layer(/<circle[^>]*\/>/))
out('icons/mac/AppIcon.icon/icon.json', Buffer.from(JSON.stringify({
  'fill-specializations': fills('#ffffff', '#0c0e13'),
  groups: [{
    layers: [
      { 'fill-specializations': fills('#111111', '#eceef3'), 'image-name': 'a.svg', name: 'a' },
      { 'fill-specializations': fills('#2f5bea', '#7f9dff'), 'image-name': 'dot.svg', name: 'dot' },
    ],
    shadow: { kind: 'neutral', opacity: 0.5 },
    translucency: { enabled: false, value: 0.5 },
  }],
  'supported-platforms': { squares: ['macOS'] },
}, null, 2) + '\n'))

// Compiled here rather than by electron-builder (mac.icon: *.icon) because
// that needs Xcode 26's actool on the release runner. Assets.car is committed;
// electron-builder.yml ships it and sets CFBundleIconName.
try {
  const tmp = mkdtempSync(join(tmpdir(), 'adf-icon-'))
  execFileSync('actool', [
    iconDir, '--compile', tmp, '--app-icon', 'AppIcon', '--include-all-app-icons',
    '--output-partial-info-plist', join(tmp, 'info.plist'), '--platform', 'macosx',
    '--target-device', 'mac', '--minimum-deployment-target', '11.0',
    '--enable-on-demand-resources', 'NO', '--development-region', 'en',
    '--errors', '--warnings',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  copyFileSync(join(tmp, 'Assets.car'), join(res, 'icons/mac/Assets.car'))
  rmSync(tmp, { recursive: true, force: true })
  console.log('icons/mac/Assets.car  compiled')
} catch (e) {
  console.warn(`icons/mac/Assets.car  NOT rebuilt (needs macOS + Xcode 26 actool): ${e.message}`)
}
