import { describe, it, expect } from 'vitest'
import { inflateSync, crc32 } from 'zlib'
import { gradientWallpaperPng } from '../../../src/main/services/desktop-wallpaper'

describe('gradientWallpaperPng', () => {
  it('emits a valid RGB PNG whose rows run from the top colour to the bottom colour', () => {
    const png = gradientWallpaperPng([10, 20, 30], [40, 50, 60], 2, 3)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(2)
    expect(png.readUInt32BE(20)).toBe(3)
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(2)
    expect([png[26], png[27], png[28]]).toEqual([0, 0, 0]) // compression, filter, interlace
    // Chunk CRC covers type + data, not the length prefix.
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)))

    const idatLength = png.readUInt32BE(33)
    expect(png.subarray(37, 41).toString('latin1')).toBe('IDAT')
    expect(png.readUInt32BE(41 + idatLength)).toBe(crc32(png.subarray(37, 41 + idatLength)))
    const raw = inflateSync(png.subarray(41, 41 + idatLength))
    const stride = 1 + 2 * 3
    expect(raw.length).toBe(stride * 3)
    expect([...raw.subarray(1, 4)]).toEqual([10, 20, 30])
    expect([...raw.subarray(stride + 1, stride + 4)]).toEqual([25, 35, 45])
    expect([...raw.subarray(2 * stride + 1, 2 * stride + 4)]).toEqual([40, 50, 60])
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND')
  })
})
