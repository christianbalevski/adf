import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { nanoid } from 'nanoid'

/**
 * Convert audio buffer (WAV/MP3/etc.) to OGG/Opus format via ffmpeg.
 * Telegram requires OGG/Opus for voice notes.
 */
export async function convertToOggOpus(input: Buffer): Promise<Buffer> {
  const id = nanoid(8)
  const inPath = join(tmpdir(), `adf_audio_in_${id}`)
  const outPath = join(tmpdir(), `adf_audio_out_${id}.ogg`)

  try {
    await fsp.writeFile(inPath, input)
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', inPath,
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vn',
        '-y',
        outPath
      ], (error) => {
        if (error) reject(new Error(`ffmpeg conversion failed: ${error.message}. Is ffmpeg installed?`))
        else resolve()
      })
    })
    return await fsp.readFile(outPath)
  } finally {
    // ffmpeg may never have created outPath (conversion failed) — both unlinks
    // are best effort so neither temp file can outlive the call.
    await fsp.unlink(inPath).catch(() => {})
    await fsp.unlink(outPath).catch(() => {})
  }
}
