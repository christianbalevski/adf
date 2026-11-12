import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { createAdfApi } from '../../../src/shared/adf-api'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { AgentFiles } from '../../../src/renderer/components/agent/AgentFiles'

;(globalThis as { React?: typeof React }).React = React

const recorder = vi.hoisted(() => ({
  drop: null as ((event: React.DragEvent) => Promise<void>) | null,
  api: null as ReturnType<typeof createAdfApi> | null,
}))
vi.mock('../../../src/renderer/utils/runtime-api', () => ({
  openApi: () => recorder.api,
  useOpenRuntime: () => 'local',
}))
// Capture the real panel handler, as tooltip-input.test.tsx does for events.
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return {
    ...original,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      if (type === 'div' && props.onDrop) recorder.drop = props.onDrop as typeof recorder.drop
      return (original.jsxDEV as (...args: unknown[]) => unknown)(type, props, ...rest)
    },
  }
})

let dir: string
let ws: AdfWorkspace
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-drop-collision-'))
  ws = AdfWorkspace.create(join(dir, 'fixture.adf'), { name: 'drop-fixture' })
  recorder.api = createAdfApi({
    runtimeId: 'local',
    // Exercise the public upload adapter and the embedded handler's existing
    // unique-vs-replace dispatch against a real, disposable VFS.
    invoke: async (channel, ...args) => {
      if (channel === IPC.DOC_GET_FILES) return { files: ws.listFiles() }
      if (channel !== IPC.DOC_UPLOAD_FILE) throw new Error(`Unexpected channel ${channel}`)
      const { path, data, mimeType, unique } = args[0] as { path: string; data: number[]; mimeType?: string; unique?: boolean }
      const bytes = Buffer.from(data)
      if (unique) return { success: true, path: ws.writeFileBufferUnique(path, bytes, mimeType) }
      ws.writeFileBuffer(path, bytes, mimeType)
      return { success: true, path }
    },
    send: () => {}, on: () => {}, removeListener: () => {},
  }, { platform: 'linux', setZoomFactor: () => {} })
  renderToStaticMarkup(<AgentFiles />)
  expect(recorder.drop).not.toBeNull()
})
afterEach(() => {
  ws?.close()
  rmSync(dir, { recursive: true, force: true })
  recorder.drop = null
  recorder.api = null
})

function file(name: string, content: string): File {
  return new File([content], name, { type: 'text/markdown' })
}
function entry(value: File): FileSystemEntry {
  return { isFile: true, name: value.name, file: (done: (f: File) => void) => done(value) } as FileSystemFileEntry
}
function folder(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false, name,
    createReader: () => {
      let read = false
      return { readEntries: (done: (entries: FileSystemEntry[]) => void) => {
        done(read ? [] : children)
        read = true
      } }
    },
  } as FileSystemDirectoryEntry
}
function drop(files: File[], entries: FileSystemEntry[] = []): Promise<void> {
  return recorder.drop!({
    preventDefault: () => {},
    dataTransfer: { files, items: entries.map(value => ({ webkitGetAsEntry: () => value })) },
  } as unknown as React.DragEvent)
}

describe('Files panel drop collisions', () => {
  it.each(['entries', 'fallback'])('keeps root agent files and numbers different content (%s)', async (mode) => {
    ws.writeFile('README.md', 'original document')
    ws.writeFile('mind.md', 'original memory')
    ws.writeFile('README-2.md', 'previous upload')
    const metadata = ws.getFileMeta('README.md')
    const files = [file('README.md', 'dropped document'), file('mind.md', 'dropped memory')]
    const entries = mode === 'entries' ? files.map(entry) : []
    await drop(files, entries)
    expect(ws.readFile('README.md')).toBe('original document')
    expect(ws.readFile('mind.md')).toBe('original memory')
    expect(ws.getFileMeta('README.md')).toEqual(metadata)
    expect(ws.readFile('README-2.md')).toBe('previous upload')
    expect(ws.readFile('README-3.md')).toBe('dropped document')
    expect(ws.readFile('mind-2.md')).toBe('dropped memory')
    await drop(files, entries)
    expect(ws.fileExists('README-4.md')).toBe(false)
    expect(ws.fileExists('mind-3.md')).toBe(false)
  })

  it('keeps different uploads from overlapping drops under separate names', async () => {
    ws.writeFile('mind.md', 'original memory')
    await Promise.all([
      drop([file('mind.md', 'first upload')]),
      drop([file('mind.md', 'second upload')]),
    ])
    expect(ws.readFile('mind.md')).toBe('original memory')
    expect(new Set([ws.readFile('mind-2.md'), ws.readFile('mind-3.md')])).toEqual(new Set(['first upload', 'second upload']))
  })

  it('keeps folder paths and existing nested files when a folder is dropped twice', async () => {
    ws.writeFile('README.md', 'root document')
    ws.writeFile('bundle/README.md', 'existing bundle document', 'read_only')
    ws.writeFile('bundle/notes/mind.md', 'existing notes')
    const entries = [folder('bundle', [entry(file('README.md', 'new bundle document')),
      folder('notes', [entry(file('mind.md', 'new notes')), entry(file('fresh.md', 'new file'))])])]
    await drop([], entries)
    await drop([], entries)
    expect(ws.readFile('README.md')).toBe('root document')
    expect(ws.readFile('bundle/README.md')).toBe('existing bundle document')
    expect(ws.getFileMeta('bundle/README.md')?.protection).toBe('read_only')
    expect(ws.readFile('bundle/README-2.md')).toBe('new bundle document')
    expect(ws.readFile('bundle/notes/mind.md')).toBe('existing notes')
    expect(ws.readFile('bundle/notes/mind-2.md')).toBe('new notes')
    expect(ws.readFile('bundle/notes/fresh.md')).toBe('new file')
    expect(ws.fileExists('bundle/README-3.md')).toBe(false)
  })
})
