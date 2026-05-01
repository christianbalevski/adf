/**
 * CI guard: no direct `eventBus.publish(` calls outside the emit-umbilical helper.
 *
 * Every runtime event must flow through emitUmbilicalEvent so the source field
 * is stamped from AsyncLocalStorage. This test fails the build if any code
 * regresses and emits directly to the daemon bus.
 *
 * Allowlist:
 *   - src/main/runtime/emit-umbilical.ts    (the helper itself)
 *   - src/main/daemon/event-bus.ts          (class definition)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')

const ALLOWLIST = new Set<string>([
  'src/main/runtime/emit-umbilical.ts',
  'src/main/daemon/event-bus.ts',
])

const DIRECT_EMIT_PATTERN = /eventBus\s*\.\s*publish\s*\(/

function walkTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
      walkTypeScriptFiles(abs, out)
    } else if (st.isFile() && (abs.endsWith('.ts') || abs.endsWith('.tsx'))) {
      out.push(abs)
    }
  }
  return out
}

describe('umbilical emit guard', () => {
  it('no direct eventBus.publish() calls outside emit-umbilical helper', () => {
    const files = walkTypeScriptFiles(SRC_ROOT)
    const offenders: string[] = []

    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/')
      if (ALLOWLIST.has(rel)) continue

      const content = readFileSync(file, 'utf-8')
      if (DIRECT_EMIT_PATTERN.test(content)) {
        offenders.push(rel)
      }
    }

    expect(offenders, `Direct eventBus.publish() call sites must route through emitUmbilicalEvent.\nOffenders:\n${offenders.join('\n')}`).toEqual([])
  })
})
