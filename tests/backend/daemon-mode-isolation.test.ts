/**
 * Guard (tracker W2-C): Studio main reads no embedded module state in daemon
 * mode. The daemon-mode module graph must not load the embedded backend at
 * all: ipc/index.ts (its module globals: currentWorkspace, currentFilePath,
 * derivedKeyCache, the approval hub subscription, …), the background agent
 * manager, the runtime, or SQLite. Each is replaced by a module that throws
 * when loaded; importing every daemon-mode module must still succeed.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

const { refuse } = vi.hoisted(() => ({
  refuse: (name: string) => () => { throw new Error(`daemon mode loaded the embedded module ${name}`) },
}))
vi.mock('../../src/main/ipc/index', refuse('ipc/index'))
vi.mock('../../src/main/runtime/background-agent-manager', refuse('background-agent-manager'))
vi.mock('../../src/main/runtime/runtime-service', refuse('runtime-service'))
vi.mock('../../src/main/runtime/agent-executor', refuse('agent-executor'))
vi.mock('../../src/main/runtime/approval-hub', refuse('approval-hub'))
vi.mock('../../src/main/services/settings.service', refuse('settings.service'))
vi.mock('../../src/main/services/podman.service', refuse('podman.service'))
vi.mock('../../src/main/adf/adf-database', refuse('adf-database'))
vi.mock('better-sqlite3', refuse('better-sqlite3'))

const DAEMON_MODE_DIR = join(__dirname, '..', '..', 'src', 'main', 'backend', 'daemon-mode')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [])
}

describe('daemon mode loads no embedded backend module', () => {
  it('the refusal works: loading an embedded module fails', async () => {
    await expect(import('../../src/main/ipc/index')).rejects.toThrow()
    await expect(import('better-sqlite3')).rejects.toThrow()
  })

  it('imports every daemon-mode module with the embedded backend refused', async () => {
    const failures: string[] = []
    for (const file of files(DAEMON_MODE_DIR)) {
      try {
        await import(/* @vite-ignore */ file)
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause
        failures.push(`${relative(DAEMON_MODE_DIR, file)}: ${err instanceof Error ? err.message : String(err)}${cause instanceof Error ? ` (${cause.message})` : ''}`)
      }
    }
    expect(failures).toEqual([])
  }, 60_000)

  it('no daemon-mode source imports the embedded IPC layer or its singletons', () => {
    const forbidden = [/from '[./]*ipc\/index'/, /from '[./]*ipc'/, /background-agent-manager'/, /runtime-service'/, /approval-hub'/, /settings\.service'/]
    for (const file of files(DAEMON_MODE_DIR)) {
      const text = readFileSync(file, 'utf8')
      for (const re of forbidden) expect(re.test(text), `${relative(DAEMON_MODE_DIR, file)} matches ${re}`).toBe(false)
    }
  })
})
