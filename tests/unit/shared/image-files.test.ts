import { describe, expect, it } from 'vitest'
import { resolveImageMime } from '../../../src/shared/utils/image-files'

describe('resolveImageMime', () => {
  it('uses the stored mime type when it names a supported image', () => {
    expect(resolveImageMime('charts/latest', 'image/png')).toBe('image/png')
    expect(resolveImageMime('photo.bin', 'IMAGE/JPEG')).toBe('image/jpeg')
    expect(resolveImageMime('logo', 'image/svg+xml; charset=utf-8')).toBe('image/svg+xml')
  })

  it('maps stored aliases onto the canonical type', () => {
    expect(resolveImageMime('a', 'image/jpg')).toBe('image/jpeg')
    expect(resolveImageMime('a', 'image/vnd.microsoft.icon')).toBe('image/x-icon')
  })

  it('falls back to the extension when the stored type is missing or generic', () => {
    expect(resolveImageMime('shots/Screen Shot.PNG')).toBe('image/png')
    expect(resolveImageMime('a.jpeg', null)).toBe('image/jpeg')
    expect(resolveImageMime('a.webp', 'application/octet-stream')).toBe('image/webp')
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']) {
      expect(resolveImageMime(`file.${ext}`)).toMatch(/^image\//)
    }
  })

  it('never passes a stored string through', () => {
    // The result becomes a Blob type, so only the allowlist may come out.
    expect(resolveImageMime('page.png', 'text/html')).toBe('image/png')
    expect(resolveImageMime('page', 'text/html')).toBeNull()
    expect(resolveImageMime('page', 'image/png, text/html')).toBeNull()
  })

  it('rejects files that are not images the viewer can show', () => {
    expect(resolveImageMime('scan.tiff', 'image/tiff')).toBeNull()
    expect(resolveImageMime('archive.zip', 'application/zip')).toBeNull()
    expect(resolveImageMime('README.md', 'text/markdown')).toBeNull()
    expect(resolveImageMime('png')).toBeNull()
    expect(resolveImageMime('dir.png/notes')).toBeNull()
  })
})
