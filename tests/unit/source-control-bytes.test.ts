import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, extname } from 'path'

/**
 * Source files must not contain raw control bytes. An editor or tool that
 * materializes an escape sequence (a NUL, 0x01, …) into the literal byte leaves
 * code that still runs, but a single NUL makes git treat the whole file as
 * binary: no line diffs, no EOL normalization, unreviewable changes. Write the
 * escape (`\0`, `\x01`) instead.
 */

const ROOT = join(__dirname, '..', '..')
const SCAN_DIRS = ['src', 'tests', 'scripts']
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.json', '.html', '.md'])
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name))
    } else if (TEXT_EXTS.has(extname(entry.name))) {
      yield join(dir, entry.name)
    }
  }
}

describe('source files', () => {
  it('contain no raw control bytes', () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const bytes = readFileSync(file)
        let line = 1
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i]
          if (b === 0x0a) line++
          // tab, LF, CR are the only control bytes a text file needs
          if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
            offenders.push(`${relative(ROOT, file)}:${line} byte 0x${b.toString(16).padStart(2, '0')}`)
            break
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
