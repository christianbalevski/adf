import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runTypecheckProjects } from '../../scripts/typecheck-projects.mjs'

describe('typecheck script', () => {
  it('checks both production projects and fails if either check fails', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 0 })

    expect(runTypecheckProjects(run)).toBe(1)
    expect(run.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'tsconfig.node.json',
      'tsconfig.web.json',
    ])
  })

  it('runs the checks when started through a linked folder (review 4300792058)', () => {
    // A copy of the scripts beside a stand-in tsc that fails, started through a link to their folder.
    const dir = mkdtempSync(join(tmpdir(), 'adf-typecheck-'))
    const link = join(dir, 'via-link')
    try {
      mkdirSync(join(dir, 'scripts'))
      for (const name of ['typecheck.mjs', 'typecheck-projects.mjs']) {
        const from = join(__dirname, '..', '..', 'scripts', name)
        if (existsSync(from)) copyFileSync(from, join(dir, 'scripts', name))
      }
      mkdirSync(join(dir, 'node_modules', 'typescript', 'bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), "console.log('fake tsc ' + process.argv.at(-1)); process.exit(2)\n")
      symlinkSync(join(dir, 'scripts'), link, 'junction')
      const result = spawnSync(process.execPath, [join(link, 'typecheck.mjs')], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
      expect(result.stdout).toContain('fake tsc tsconfig.node.json')
      expect(result.stdout).toContain('fake tsc tsconfig.web.json')
      expect(result.status).toBe(1)
    } finally {
      // Unlink the link itself first (a recursive delete would follow it), and check it is gone.
      const linked = () => { try { lstatSync(link); return true } catch { return false } }
      if (linked()) unlinkSync(link)
      if (linked()) throw new Error(`could not unlink ${link}; leaving ${dir} in place`)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
