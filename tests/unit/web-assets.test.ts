import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findWebRoot } from '../../src/main/daemon/web/assets'

describe('browser build discovery', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adf-web-assets-'))
    vi.stubEnv('ADF_WEB_ROOT', '')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs() })
  function entry(path: string): string {
    const dir = join(root, path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    return dir
  }
  it('serves built output rather than the source HTML, independently of cwd', () => {
    entry('project/src/web')
    const built = entry('project/out/web')
    entry('unrelated/out/web')
    expect(findWebRoot(undefined, join(root, 'project/src/main/daemon/web'), join(root, 'unrelated'))).toBe(built)
  })
  it('reports a missing build instead of serving uncompiled TypeScript', () => {
    entry('project/src/web')
    expect(findWebRoot(undefined, join(root, 'project/src/main/daemon/web'), root)).toBeNull()
  })
  it.each(['app/out/main', 'app/out/main/daemon-chunks'])('finds Electron assets from %s', (moduleDir) => {
    const built = entry('app/out/web')
    expect(findWebRoot(undefined, join(root, moduleDir), root)).toBe(built)
  })
  it('finds npm package assets before a surrounding checkout build', () => {
    const built = entry('project/dist/npm/web')
    entry('project/out/web')
    expect(findWebRoot(undefined, join(root, 'project/dist/npm/dist/chunks'), join(root, 'project'))).toBe(built)
  })
  it('honors explicit asset roots before the environment override', () => {
    vi.stubEnv('ADF_WEB_ROOT', join(root, 'environment'))
    expect(findWebRoot(join(root, 'explicit'))).toBe(join(root, 'explicit'))
    expect(findWebRoot()).toBe(join(root, 'environment'))
  })
})
