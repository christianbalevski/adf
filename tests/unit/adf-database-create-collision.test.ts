import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { join, relative, resolve } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { AdfDatabase } from '../../src/main/adf/adf-database'

function createDir(): string {
  return mkdtempSync(join(tmpdir(), 'adf-create-collision-'))
}

function createSeed(filePath: string, name: string): void {
  AdfDatabase.create(filePath, { name }).close()
}

function runConcurrentCreate(filePath: string, name: string): Promise<{ ok: boolean; output: string }> {
  const script = `
    const { AdfDatabase } = require('./src/main/adf/adf-database')
    try {
      const db = AdfDatabase.create(process.argv[1], { name: process.argv[2] })
      db.close()
      process.stdout.write(JSON.stringify({ ok: true }))
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error) }))
      process.exitCode = 0
    }
  `
  const timeoutMs = 30_000
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['-r', require.resolve('tsx/cjs'), '-e', script, filePath, name], {
      cwd: resolve(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`child timed out after ${timeoutMs}ms: ${error}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { error += String(chunk) })
    child.once('error', (spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(spawnError)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`child exited ${code}: ${error}`))
      else resolvePromise({ ok: output.includes('"ok":true'), output })
    })
  })
}


describe('AdfDatabase collision-safe creation', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects an existing file without changing it or its WAL/SHM sidecars', () => {
    const dir = createDir(); dirs.push(dir)
    const filePath = join(dir, 'existing.adf')
    createSeed(filePath, 'original')
    const original = readFileSync(filePath)
    const wal = Buffer.from('original-wal')
    const shm = Buffer.from('original-shm')
    writeFileSync(`${filePath}-wal`, wal)
    writeFileSync(`${filePath}-shm`, shm)

    expect(() => AdfDatabase.create(filePath, { name: 'replacement' })).toThrow(/already exists/)
    expect(readFileSync(filePath)).toEqual(original)
    expect(readFileSync(`${filePath}-wal`)).toEqual(wal)
    expect(readFileSync(`${filePath}-shm`)).toEqual(shm)
    expect(readdirSync(dir).sort()).toEqual(['existing.adf', 'existing.adf-shm', 'existing.adf-wal'])
  }, 30_000)

  it('reaps orphan sidecars through the established lifecycle before creating', () => {
    const dir = createDir(); dirs.push(dir)
    const filePath = join(dir, 'orphan.adf')
    writeFileSync(`${filePath}-wal`, Buffer.from('orphan-wal'))
    writeFileSync(`${filePath}-shm`, Buffer.from('orphan-shm'))

    const db = AdfDatabase.create(filePath, { name: 'orphan' })
    db.close()
    expect(existsSync(filePath)).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['orphan.adf'])
  })

  it('creates a new file without auxiliary reservation artifacts', () => {
    const dir = createDir(); dirs.push(dir)
    const filePath = join(dir, 'new-agent.adf')
    const db = AdfDatabase.create(filePath, { name: 'new-agent' })
    try {
      expect(db.getConfig().name).toBe('new-agent')
    } finally { db.close() }
    expect(existsSync(filePath)).toBe(true)
    expect(readdirSync(dir)).toEqual(['new-agent.adf'])
  })

  it('removes only the failed reserved destination when initialization fails', () => {
    const dir = createDir(); dirs.push(dir)
    const filePath = join(dir, 'failed.adf')
    const invalidOptions = {
      name: 'failed-agent',
      metadata: { tags: [BigInt(1) as unknown as string] },
    }

    expect(() => AdfDatabase.create(filePath, invalidOptions)).toThrow()
    expect(existsSync(filePath)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('allows only one winner when two independent processes create the same name', async () => {
    const dir = createDir(); dirs.push(dir)
    const filePath = join(dir, 'race.adf')
    const results = await Promise.all([
      runConcurrentCreate(filePath, 'one'),
      runConcurrentCreate(filePath, 'two'),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toHaveLength(1)
    const opened = AdfDatabase.open(filePath)
    try { expect(opened.getConfig().name).toMatch(/one|two/) } finally { opened.close() }
    const leftovers = readdirSync(dir).filter((entry) => entry !== 'race.adf')
    expect(leftovers).toEqual([])
  })


  it('rejects symlink aliases without touching the target', () => {
    const dir = createDir(); dirs.push(dir)
    const targetPath = join(dir, 'target.adf')
    const aliasPath = join(dir, 'alias.adf')
    createSeed(targetPath, 'target')
    const before = readFileSync(targetPath)
    symlinkSync(targetPath, aliasPath)

    expect(() => AdfDatabase.create(aliasPath, { name: 'replacement' })).toThrow(/already exists/)
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(aliasPath)).toBe(targetPath)
    expect(readFileSync(targetPath)).toEqual(before)
  }, 30_000)

  it('rejects relative and absolute aliases of the same destination', () => {
    const dir = createDir(); dirs.push(dir)
    const filePath = join(dir, 'alias.adf')
    createSeed(filePath, 'original')
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(() => AdfDatabase.create(relative(dir, filePath), { name: 'replacement' })).toThrow(/already exists/)
    } finally { process.chdir(cwd) }
    const opened = AdfDatabase.open(filePath)
    try { expect(opened.getConfig().name).toBe('original') } finally { opened.close() }
  })
})
