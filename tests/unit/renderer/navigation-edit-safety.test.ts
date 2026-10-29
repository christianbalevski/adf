import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { useAdfFile } from '../../../src/renderer/hooks/useAdfFile'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useEditorTabsStore, beginAgentSwitch, endAgentSwitch, isAgentSwitching } from '../../../src/renderer/stores/editor-tabs.store'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useFailureNoticesStore } from '../../../src/renderer/stores/failure-notices.store'
import { captureAgentView } from '../../../src/renderer/utils/agent-view'
import { registerEditorFlush, resetEditorSaves, saveEditorTab } from '../../../src/renderer/utils/editor-save'
import { classifySave, saveTabContent, type SaveAnswer } from '../../../src/renderer/utils/edit-conflict'

const doc = () => useDocumentStore.getState()
const tabs = () => useEditorTabsStore.getState()
const tab = () => tabs().tabs.find((t) => t.path === 'notes.md')
const cleanups: Array<() => void> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    openFile: vi.fn(async (filePath: string) => ({ success: true, filePath })),
    closeFile: vi.fn(async () => {}),
    getBatch: vi.fn(async () => ({ document: 'B document', agentConfig: null, chat: { uiLog: [] } })),
    readInternalFile: vi.fn(async () => null),
    checkAgentReview: vi.fn(async () => ({ needsReview: false })),
    writeInternalFile: vi.fn(async () => ({ success: true, revision: 2 })),
    ...overrides,
  }
  vi.stubGlobal('window', { adfApi: api, confirm: () => true })
  return api
}

function fileActions() {
  let actions!: ReturnType<typeof useAdfFile>
  function Probe() { actions = useAdfFile(); return null }
  renderToString(createElement(Probe))
  return actions
}

beforeEach(() => {
  while (isAgentSwitching()) endAgentSwitch()
  doc().reset()
  tabs().reset()
  useAgentStore.getState().reset()
  useFailureNoticesStore.setState({ notices: [] })
  resetEditorSaves()
  doc().setFilePath('/a.adf', 'local')
  tabs().openTab('notes.md', 'base', false, undefined, 1)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})
afterEach(() => { cleanups.splice(0).forEach((off) => off()); vi.unstubAllGlobals() })

describe('save responses belong to their originating view', () => {
  for (const answer of [
    { success: true, revision: 2 },
    { success: false, conflict: { resource: 'notes.md', revision: 2, writer: null, content: 'theirs' } },
    { success: false, conflict: { resource: 'notes.md', revision: 2, writer: null, content: 'base' } },
  ] satisfies SaveAnswer[]) {
    for (const change of ['other agent', 'other runtime', 'A-B-A', 'switch in progress']) {
      it(`ignores ${JSON.stringify(answer)} after ${change}`, async () => {
        const saved = deferred<SaveAnswer>()
        const write = vi.fn(() => saved.promise)
        installApi({ writeInternalFile: write })
        tabs().updateTabContent('notes.md', 'A private text')
        const pending = saveEditorTab('notes.md', 'A private text', '/a.adf')
        await Promise.resolve()
        if (change === 'other agent') doc().setFilePath('/b.adf')
        if (change === 'other runtime') doc().setFilePath('/a.adf', 'remote')
        if (change === 'A-B-A') { doc().setFilePath('/b.adf'); doc().setFilePath('/a.adf') }
        if (change === 'switch in progress') beginAgentSwitch()
        tabs().reset()
        tabs().openTab('notes.md', 'incoming text', false, undefined, 100)
        const incoming = tab()
        saved.resolve(answer)
        expect(await pending).toBeNull()
        expect(tab()).toBe(incoming)
        expect(write).toHaveBeenCalledTimes(1)
        if (change === 'switch in progress') endAgentSwitch()
      })
    }
  }

  it('does not reopen a previous agent’s refused tab in the incoming agent', async () => {
    const saved = deferred<SaveAnswer>()
    installApi({ writeInternalFile: () => saved.promise })
    const pending = saveEditorTab('notes.md', 'A private text', '/a.adf')
    await Promise.resolve()
    doc().setFilePath('/b.adf')
    tabs().reset()
    saved.resolve({ success: false, conflict: { resource: 'notes.md', revision: 2, writer: null, content: 'A external' } })
    expect(await pending).toBeNull()
    expect(tabs().tabs).toEqual([])
  })

  it('rejects a scheduled edit from an earlier view with the same runtime and path', async () => {
    const api = installApi()
    const oldView = captureAgentView()
    doc().setFilePath('/b.adf')
    doc().setFilePath('/a.adf')
    expect(await saveEditorTab('notes.md', 'old', '/a.adf', undefined, oldView)).toBeNull()
    expect(api.writeInternalFile).not.toHaveBeenCalled()
  })
})

describe('explicit save failures', () => {
  it('preserves unsaved text, its revision and dirty flag, and reports the error', async () => {
    installApi({ writeInternalFile: async () => ({ success: false, error: 'No file open' }) })
    tabs().updateTabContent('notes.md', 'unsaved')
    expect(await saveEditorTab('notes.md', 'unsaved', '/a.adf')).toEqual({ kind: 'failed', error: 'No file open' })
    expect(tab()).toMatchObject({ content: 'unsaved', savedContent: 'base', revision: 1, isDirty: true })
    expect(useFailureNoticesStore.getState().notices.at(-1)?.text).toContain('No file open')
    expect(classifySave({ success: false }, 'base', 'unsaved').kind).toBe('failed')
  })

  it('restores refused text if its tab closed before the failure arrived', async () => {
    const saved = deferred<SaveAnswer>()
    const pending = saveTabContent('notes.md', 'unsaved', () => saved.promise)
    tabs().closeTab('notes.md')
    saved.resolve({ success: false })
    await pending
    expect(tab()).toMatchObject({ content: 'unsaved', savedContent: 'base', revision: 1, isDirty: true })
  })
})

describe('navigation drains editor changes before replacing the workspace', () => {
  for (const operation of ['open', 'close', 'create', 'quick create']) {
    it(`waits for editor-local keystrokes to be saved before ${operation}`, async () => {
      const saved = deferred<SaveAnswer>()
      const write = vi.fn(() => saved.promise)
      const create = vi.fn(async () => ({ success: true, filePath: '/new.adf' }))
      const api = installApi({ writeInternalFile: write, createFile: create, createQuickAgent: create })
      const actions = fileActions()
      // Editor-local text has not reached its 250 ms debounce. The registered
      // flush publishes it synchronously, as CodeMirror/Markdown now do.
      let localText: string | null = 'typed immediately before navigation'
      cleanups.push(registerEditorFlush(() => {
        if (localText === null) return
        const text = localText
        localText = null
        tabs().updateTabContent('notes.md', text)
        return saveEditorTab('notes.md', text, doc().filePath)
      }))
      const pending = operation === 'open' ? actions.openFile('/b.adf')
        : operation === 'close' ? actions.closeFile()
          : operation === 'create' ? actions.createFile('new') : actions.createQuickAgent()
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
      expect(api.openFile).not.toHaveBeenCalled()
      expect(api.closeFile).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(isAgentSwitching()).toBe(false)
      expect(doc().filePath).toBe('/a.adf')
      saved.resolve({ success: true, revision: 2 })
      await pending
      expect(write).toHaveBeenCalledWith('notes.md', 'typed immediately before navigation', { baseRevision: 1 })
      expect(doc().filePath).toBe(operation === 'close' ? null : operation === 'open' ? '/b.adf' : '/new.adf')
    })
  }

  it('keeps the outgoing agent open when saving its dirty text fails', async () => {
    const api = installApi({ writeInternalFile: async () => ({ success: false, error: 'No file open' }) })
    tabs().updateTabContent('notes.md', 'do not lose this')
    await fileActions().openFile('/b.adf')
    expect(api.openFile).not.toHaveBeenCalled()
    expect(doc().filePath).toBe('/a.adf')
    expect(tab()).toMatchObject({ content: 'do not lose this', isDirty: true })
  })

  it('saves dirty inactive tabs too', async () => {
    const api = installApi()
    tabs().updateTabContent('notes.md', 'inactive edit')
    tabs().openTab('other.md', 'clean', false, undefined, 1)
    await fileActions().openFile('/b.adf')
    expect(api.writeInternalFile).toHaveBeenCalledWith('notes.md', 'inactive edit', { baseRevision: 1 })
  })
})

describe('foreground refresh responses', () => {
  for (const change of ['other agent', 'other runtime', 'A-B-A', 'switch in progress']) {
    it(`discards an old turn header after ${change}`, async () => {
      const header = deferred<unknown>()
      installApi({ getHeader: () => header.promise })
      createAgentEventHandler()({ type: 'turn_complete', payload: {}, timestamp: 1 } as never)
      if (change === 'other agent') doc().setFilePath('/b.adf')
      if (change === 'other runtime') doc().setFilePath('/a.adf', 'remote')
      if (change === 'A-B-A') { doc().setFilePath('/b.adf'); doc().setFilePath('/a.adf') }
      if (change === 'switch in progress') beginAgentSwitch()
      doc().setDocumentContent('current document')
      useAgentStore.getState().setConfig({ name: 'current agent' } as never)
      useAgentStore.getState().setStatusText('current status')
      header.resolve({ document: 'old document', agentConfig: { name: 'old agent' }, statusText: 'old status' })
      await Promise.resolve()
      expect(doc().documentContent).toBe('current document')
      expect(useAgentStore.getState().config?.name).toBe('current agent')
      expect(useAgentStore.getState().statusText).toBe('current status')
      if (change === 'switch in progress') endAgentSwitch()
    })
  }

  it('still applies a header to the view that requested it', async () => {
    installApi({ getHeader: async () => ({ document: 'latest', agentConfig: null, statusText: 'ready' }) })
    createAgentEventHandler()({ type: 'turn_complete', payload: {}, timestamp: 1 } as never)
    await Promise.resolve()
    expect(doc().documentContent).toBe('latest')
    expect(useAgentStore.getState().statusText).toBe('ready')
  })
})
