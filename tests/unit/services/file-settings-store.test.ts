import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ctl = vi.hoisted(() => ({ failWrites: false, blockRead: false }))

vi.mock('../../../src/main/utils/atomic-json', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/utils/atomic-json')>()
  return {
    ...real,
    writeJsonAtomic: (path: string, data: unknown) => {
      if (ctl.failWrites) {
        const err = new Error('EPERM: destination held open') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      real.writeJsonAtomic(path, data)
    },
    readJsonOrQuarantine: (path: string) => {
      if (ctl.blockRead) return { data: null, quarantinedTo: null, corruptUnpreserved: true }
      return real.readJsonOrQuarantine(path)
    },
  }
})

import { FileSettingsStore } from '../../../src/main/daemon/file-settings-store'
import { DEFAULT_COMPUTE_SETTINGS } from '../../../src/shared/constants/compute-defaults'
import { DEFAULT_TOOL_PROMPTS } from '../../../src/shared/constants/adf-defaults'

let dir: string
let file: string

function seed(data: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(data), 'utf-8')
}

function readDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-file-settings-'))
  file = join(dir, 'adf-settings.json')
  ctl.failWrites = false
  ctl.blockRead = false
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FileSettingsStore migrations (parity with SettingsService)', () => {
  it('backfills stale compute, tool prompts, prompt sections and adapters, and persists', () => {
    seed({
      compute: { containerPackages: ['py3-pip', 'git'], hostAccessEnabled: true },
      toolPrompts: { custom_tool: 'my prompt' },
      globalSystemPrompt: 'You are agent-1.',
      adapters: [],
    })

    const store = new FileSettingsStore(file)
    const compute = store.get('compute') as Record<string, unknown>
    const pkgs = compute.containerPackages as string[]

    // Stale Alpine name removed, required (incl. VNC) packages merged in
    expect(pkgs).not.toContain('py3-pip')
    expect(pkgs).toContain('git')
    for (const pkg of DEFAULT_COMPUTE_SETTINGS.containerPackages) {
      expect(pkgs).toContain(pkg)
    }
    expect(compute.hostAccessEnabled).toBe(true)
    expect(compute.executionTargets).toEqual([])
    expect(compute.containerImage).toBe(DEFAULT_COMPUTE_SETTINGS.containerImage)

    const toolPrompts = store.get('toolPrompts') as Record<string, string>
    expect(toolPrompts.custom_tool).toBe('my prompt')
    for (const key of Object.keys(DEFAULT_TOOL_PROMPTS)) {
      expect(toolPrompts[key]).toBeDefined()
    }

    const prompt = store.get('globalSystemPrompt') as string
    expect(prompt).toContain('You are agent-1.')
    expect(prompt).toContain('{{soul.md}}')
    expect(prompt).toContain('{{mind.md}}')

    expect((store.get('adapters') as unknown[]).length).toBeGreaterThan(0)

    // Migrated store is persisted, not just in-memory
    const disk = readDisk()
    expect((disk.compute as Record<string, unknown>).executionTargets).toEqual([])
    expect(disk.globalSystemPrompt).toContain('{{mind.md}}')
  })
})

describe('FileSettingsStore compute merge', () => {
  it('set("compute", partial) merges instead of replacing wholesale', () => {
    seed({
      compute: {
        containerPackages: [...DEFAULT_COMPUTE_SETTINGS.containerPackages],
        hostAccessEnabled: true,
        hostApproved: ['tool-a'],
        executionTargets: [{ id: 'target-1' }],
        machineCpus: 2,
        machineMemoryMb: 2048,
        containerImage: DEFAULT_COMPUTE_SETTINGS.containerImage,
      },
    })
    const store = new FileSettingsStore(file)

    store.set('compute', { machineCpus: 8 })

    const compute = readDisk().compute as Record<string, unknown>
    expect(compute.machineCpus).toBe(8)
    expect(compute.hostAccessEnabled).toBe(true)
    expect(compute.hostApproved).toEqual(['tool-a'])
    expect(compute.executionTargets).toEqual([{ id: 'target-1' }])
  })

  it('update() applies the same merge semantics for compute', () => {
    seed({ compute: { hostAccessEnabled: true, executionTargets: [{ id: 'target-1' }] } })
    const store = new FileSettingsStore(file)

    store.update({ compute: { machineMemoryMb: 4096 }, theme: 'dark' })

    const disk = readDisk()
    const compute = disk.compute as Record<string, unknown>
    expect(compute.machineMemoryMb).toBe(4096)
    expect(compute.hostAccessEnabled).toBe(true)
    expect(compute.executionTargets).toEqual([{ id: 'target-1' }])
    expect(disk.theme).toBe('dark')
  })
})

describe('FileSettingsStore write failure handling', () => {
  it('never throws from set() when the disk write fails, and retries with retained keys', () => {
    seed({ theme: 'light' })
    const store = new FileSettingsStore(file)
    const before = readDisk()

    ctl.failWrites = true
    expect(() => store.set('theme', 'dark')).not.toThrow()
    expect(readDisk()).toEqual(before) // nothing torn or half-written

    ctl.failWrites = false
    store.set('meshPort', 4321)

    const disk = readDisk()
    expect(disk.theme).toBe('dark') // retained across the failed save
    expect(disk.meshPort).toBe(4321)
  })

  it('refuses to overwrite a corrupt file that could not be quarantined', () => {
    writeFileSync(file, 'not json {{', 'utf-8')
    ctl.blockRead = true

    const store = new FileSettingsStore(file)
    store.set('theme', 'dark')
    // The corrupt bytes are the only copy of the user's data — untouched.
    expect(readFileSync(file, 'utf-8')).toBe('not json {{')

    // Once the file becomes readable again (here: quarantine succeeds), writes resume.
    ctl.blockRead = false
    store.set('meshPort', 4321)
    const disk = readDisk()
    expect(disk.theme).toBe('dark')
    expect(disk.meshPort).toBe(4321)
    // Corrupt original was quarantined, not destroyed
    expect(readdirSync(dir).some((n) => n.includes('corrupt-'))).toBe(true)
  })
})
