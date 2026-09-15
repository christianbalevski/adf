import { deflateSync } from 'zlib'

/** CRC-32 (PNG chunk checksum). Table built once. */
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}
function crc32(buf: Buffer): number {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

export type Rgb = [number, number, number]

/**
 * A tiny vertical-gradient PNG (8-bit RGB), meant to be stretched to the
 * screen by the desktop (pcmanfm wallpaper_mode=stretch): GdkPixbuf scales
 * bilinearly, so a narrow, tall strip renders as a smooth full-screen
 * gradient. Pure Node — no image tooling in the container or on the host.
 */
export function gradientWallpaperPng(top: Rgb, bottom: Rgb, width = 4, height = 512): Buffer {
  const stride = 1 + width * 3
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    const t = height > 1 ? y / (height - 1) : 0
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        raw[y * stride + 1 + x * 3 + c] = Math.round(top[c] + (bottom[c] - top[c]) * t)
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
