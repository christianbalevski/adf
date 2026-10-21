import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// The CLI starts the daemon detached (DETACHED_PROCESS: no console). On
// Windows every console program it then spawns without `windowsHide: true`
// gets its own visible console window — `adf` start/stop flashed dozens of
// podman/uv/npm windows. Every child_process call in src/main must set it.
// Tests run the same way (background agents start vitest from a shell with no
// console), so a test or script that spawns a console program (cmd, taskkill,
// icacls, node) without it pops a window on the owner's desktop: the same rule
// covers src/, tests/ and scripts/. Third-party spawns are not seen here: the
// MCP SDK's stdio transport has its own test (mcp-stdio-windows-hide.test.ts).

const REPO = join(__dirname, '..', '..', '..')
const ROOTS = ['src', 'tests', 'scripts']
const FNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
const MODULE = String.raw`['"](?:node:)?child_process['"]|['"]cross-spawn['"]`

// Call sites that never run on Windows, never reach a process, or must show a
// window. Repo-relative path, then the start of the call.
const ALLOW = new Set([
  'src/main/tui/util/editor.ts:spawn(bin, [...args, file]',           // POSIX branch; win32 branch sets windowsHide: false on purpose
  'src/main/utils/login-shell-path.ts:execFileSync(shell, args',      // darwin/linux only
  "src/main/cli/daemon-control.ts:execFileSync('pgrep'",              // darwin/linux only
  "scripts/generate-icons.mjs:execFileSync('actool'",                 // darwin only
  'scripts/install-mac-x64-deps.mjs:execFileSync("npm"',              // darwin x64 CI only
  "scripts/electron-smoke.mjs:spawn(binary, [...args, '--inspect=0']", // darwin only; launches the packaged GUI app
  'scripts/electron-smoke.mjs:spawn(binary, args',                     // darwin only; second launch of the packaged GUI app
  // The parity fence refuses these before any process starts.
  "tests/parity/harness.test.ts:esm.spawn('podman', ['ps'])",
  "tests/parity/harness.test.ts:cjs.execFile(String.raw`C:\\Program Files\\RedHat\\Podman\\podman.exe`",
  'tests/parity/harness.test.ts:esm.exec(String.raw`"C:\\Program Files\\RedHat\\Podman\\podman.exe" stop adf-mcp`)',
  "tests/parity/harness.test.ts:esm.spawn('cmd', ['/c', 'podman stop adf-mcp'])",
  "tests/parity/harness.test.ts:esm.spawn('sh', ['-c', 'cd /x && podman ps'])",
  "tests/parity/harness.test.ts:esm.spawn('echo podman.exe', [], { shell: true })",
  "tests/parity/harness.test.ts:esm.execSync('wsl -l')",
  'tests/parity/fence-write-safety.test.ts:exec(`echo unsafe > ${state.settings}`)',
  "tests/parity/fence-write-safety.test.ts:spawn('sh', ['-c', 'true'])",
  // Probe source run inside the sandbox, which denies the spawn.
  "tests/unit/security/sandbox-host-permissions.test.ts:cp.execFileSync(process.execPath, ['-e', '1'])",
])
// This file's own examples are strings, not calls.
const SELF = 'tests/unit/daemon/windows-hide.test.ts'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' || name === '__snapshots__' ? [] : files(p)
    return /\.(?:tsx?|[cm]?js)$/.test(name) ? [p] : []
  })
}

/**
 * Callable names bound to child_process functions: named imports and
 * destructured require/dynamic import (with aliases), promisified copies, and
 * `ns.fn` for a namespace bound by `import * as ns`, a default import,
 * `require(...)`, `await import(...)` or `createRequire(...)(...)`.
 */
function childProcessNames(src: string): string[] {
  const names = new Set<string>()
  const addParts = (list: string, sep: RegExp) => {
    for (const part of list.split(',')) {
      const [orig, alias] = part.trim().replace(/^type\s+/, '').split(sep)
      if (FNS.includes(orig.trim())) names.add((alias ?? orig).trim())
    }
  }
  for (const m of src.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*(?:${MODULE})`, 'g'))) addParts(m[1], /\s+as\s+/)
  for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+import|require|createRequire\([^)]*\))\(\s*(?:${MODULE})\s*\)`, 'g'))) addParts(m[1], /\s*:\s*/)
  const namespaces = [
    ...src.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*(?:${MODULE})`, 'g')),
    ...src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+import|require|createRequire\([^)]*\))\(\s*(?:${MODULE})\s*\)`, 'g')),
  ].map(m => m[1])
  for (const ns of namespaces) for (const fn of FNS) names.add(`${ns}.${fn}`)
  // cross-spawn's default export is itself a spawn.
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s*['"]cross-spawn['"]/g)) names.add(m[1])
  if (names.size === 0) return []
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*promisify\(([\w.]+)\)/g)) if (names.has(m[2])) names.add(m[1])
  // Plain aliases, e.g. an injectable default `run = spawnSync`.
  for (const m of src.matchAll(/(\w+)\s*=\s*([\w.]+)\s*[,;)\n]/g)) if (names.has(m[2])) names.add(m[1])
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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `file:line call` for every call in `src` that can open a console window on Windows. */
function missingWindowsHide(rel: string, src: string): string[] {
  const names = childProcessNames(src)
  if (names.length === 0) return []
  const missing: string[] = []
  const re = new RegExp(`(?<![\\w.])(${names.map(escape).join('|')})\\(`, 'g')
  for (const m of src.matchAll(re)) {
    const call = callText(src, m.index!)
    if (/windowsHide/.test(call)) continue
    // DETACHED_PROCESS without windowsHide always opens a new console: never allowlisted.
    const detached = /detached:\s*true/.test(call)
    if (!detached && [...ALLOW].some(a => { const i = a.indexOf(':'); return a.slice(0, i) === rel && call.startsWith(a.slice(i + 1)) })) continue
    const line = src.slice(0, m.index).split('\n').length
    missing.push(`${rel}:${line} ${call.split('\n')[0]}`)
  }
  return missing
}

describe('windowsHide on every child_process call', () => {
  it('src/, tests/ and scripts/ spawn nothing that can pop a console window on Windows', () => {
    const missing: string[] = []
    for (const root of ROOTS) {
      for (const file of files(join(REPO, root))) {
        const rel = relative(REPO, file).replace(/\\/g, '/')
        if (rel !== SELF) missing.push(...missingWindowsHide(rel, readFileSync(file, 'utf-8')))
      }
    }
    expect(missing).toEqual([])
  })

  it('sees every way a file binds child_process, and detached spawns', () => {
    const cases: Array<[string, number]> = [
      ["import { spawn as s } from 'node:child_process'\ns('cmd', [])", 1],
      ["import * as cp from 'child_process'\ncp.execFileSync('taskkill', [])", 1],
      ["import cp from 'node:child_process'\ncp.spawn('icacls', [])", 1],
      ["const cp = require('child_process')\ncp.exec('net use')", 1],
      ["const { execFileSync: run } = await import('node:child_process')\nrun('reg', [])", 1],
      ["const esm = await import('node:child_process')\nesm.spawn('cmd')", 1],
      ["const cjs = createRequire(x)('child_process')\ncjs.spawnSync('cmd')", 1],
      ["import { execFile } from 'child_process'\nconst run = promisify(execFile)\nrun('podman', [])", 1],
      ["import crossSpawn from 'cross-spawn'\ncrossSpawn('npx', [])", 1],
      ["import { spawnSync } from 'node:child_process'\nfunction f(run = spawnSync) { run('tsc', []) }", 1],
      ["import { spawn } from 'node:child_process'\nspawn('cmd', [], { windowsHide: true })", 0],
      ["import { spawn } from 'child_process'\nspawn(bin, [...args, file], { detached: true })", 1],
    ]
    for (const [src, n] of cases) expect(missingWindowsHide('x.ts', src), src).toHaveLength(n)
    // An allowlisted call still fails when it starts a detached process.
    expect(missingWindowsHide('src/main/tui/util/editor.ts', "import { spawn } from 'node:child_process'\nspawn(bin, [...args, file], { stdio: 'inherit' })")).toHaveLength(0)
    expect(missingWindowsHide('src/main/tui/util/editor.ts', "import { spawn } from 'node:child_process'\nspawn(bin, [...args, file], { detached: true })")).toHaveLength(1)
  })
})
