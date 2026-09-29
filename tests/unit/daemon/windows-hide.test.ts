import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// The CLI starts the daemon detached (DETACHED_PROCESS: no console). On
// Windows every console program it then spawns without `windowsHide: true`
// gets its own visible console window — `adf` start/stop flashed dozens of
// podman/uv/npm windows. Every child_process call in src/main must set it.

const ROOT = join(__dirname, '..', '..', '..', 'src', 'main')
const FNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']

// Call sites that never run on Windows, or that must show a window.
const ALLOW = new Set([
  'tui/util/editor.ts:spawn(bin, [...args, file]',           // POSIX branch; win32 branch sets windowsHide: false on purpose
  'utils/login-shell-path.ts:execFileSync(shell, args',      // darwin/linux only
  "cli/daemon-control.ts:execFileSync('pgrep'",              // darwin/linux only
  "services/firewall-service.ts:execFileAsync('osascript'",  // darwin only
  "services/firewall-service.ts:execFileAsync('pkexec'",     // linux only
])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(name) ? [p] : []
  })
}

/** Local names bound to child_process functions (incl. promisified ones). */
function childProcessNames(src: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
      if (FNS.includes(orig)) names.add((alias ?? orig).trim())
    }
  }
  if (names.size === 0) return []
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*promisify\((\w+)\)/g)) if (names.has(m[2])) names.add(m[1])
  return [...names]
}

/** Text of the call starting at `start` (the name), up to its closing paren. */
function callText(src: string, start: number): string {
  let depth = 0
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start)
}

describe('windowsHide on every child_process call', () => {
  it('src/main spawns nothing that can pop a console window on Windows', () => {
    const missing: string[] = []
    for (const file of files(ROOT)) {
      const src = readFileSync(file, 'utf-8')
      const names = childProcessNames(src)
      if (names.length === 0) continue
      const rel = relative(ROOT, file).replace(/\\/g, '/')
      const re = new RegExp(`(?<![\\w.])(${names.join('|')})\\(`, 'g')
      for (const m of src.matchAll(re)) {
        const call = callText(src, m.index!)
        if (/windowsHide/.test(call)) continue
        if ([...ALLOW].some(a => { const [f, head] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)]; return f === rel && call.startsWith(head) })) continue
        const line = src.slice(0, m.index).split('\n').length
        missing.push(`${rel}:${line} ${call.split('\n')[0]}`)
      }
    }
    expect(missing).toEqual([])
  })
})
