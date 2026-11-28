import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import {
  deleteAgentFile, downloadAgentFile, duplicateAgentFile, duplicatePath, renameAgentFile, renameAgentFolder,
} from '../../../src/renderer/utils/agent-file-actions'

const api = vi.hoisted(() => ({
  getInternalFiles: vi.fn(),
  readInternalFile: vi.fn(),
  writeInternalFiles: vi.fn(),
  renameInternalFile: vi.fn(),
  renameFolder: vi.fn(),
  deleteInternalFile: vi.fn(),
  downloadInternalFile: vi.fn(),
}))
const { saveFileNow, reportFailure } = vi.hoisted(() => ({ saveFileNow: vi.fn(), reportFailure: vi.fn() }))
vi.mock('../../../src/renderer/utils/runtime-api', () => ({ openApi: () => api }))
vi.mock('../../../src/renderer/utils/editor-save', () => ({ saveFileNow }))
vi.mock('../../../src/renderer/stores/failure-notices.store', () => ({ reportFailure }))

const tab = (path: string) => useEditorTabsStore.getState().tabs.find((t) => t.path === path)
const paths = () => useEditorTabsStore.getState().tabs.map((t) => t.path)

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset())
  saveFileNow.mockReset().mockResolvedValue(true)
  reportFailure.mockReset()
  useEditorTabsStore.getState().reset()
  useDocumentStore.setState({ filePath: '/agents/a.adf' })
})

describe('duplicatePath', () => {
  it('takes the first free "copy" name, keeping folder and extension', () => {
    expect(duplicatePath('notes.md', new Set())).toBe('notes copy.md')
    expect(duplicatePath('out/notes.md', new Set(['out/notes copy.md', 'out/notes copy 2.md']))).toBe('out/notes copy 3.md')
    expect(duplicatePath('Makefile', new Set())).toBe('Makefile copy')
    expect(duplicatePath('v1.2/LICENSE', new Set())).toBe('v1.2/LICENSE copy')
    expect(duplicatePath('.env', new Set())).toBe('.env copy')
  })
})

describe('duplicateAgentFile', () => {
  it('saves the unsaved text first, copies the file, never over another, and opens the copy', async () => {
    api.readInternalFile.mockResolvedValue({ content: 'latest', binary: false })
    api.getInternalFiles.mockResolvedValue({ files: [{ path: 'notes.md' }, { path: 'notes copy.md' }] })
    api.writeInternalFiles.mockResolvedValue({ success: true, revisions: { 'notes copy 2.md': 3 } })

    await expect(duplicateAgentFile('notes.md')).resolves.toBe(true)

    expect(saveFileNow).toHaveBeenCalledWith('notes.md')
    expect(saveFileNow.mock.invocationCallOrder[0]).toBeLessThan(api.readInternalFile.mock.invocationCallOrder[0])
    expect(api.writeInternalFiles).toHaveBeenCalledWith('/agents/a.adf', [{ path: 'notes copy 2.md', content: 'latest', mustNotExist: true }])
    expect(useEditorTabsStore.getState().activeTabPath).toBe('notes copy 2.md')
    expect(tab('notes copy 2.md')).toMatchObject({ content: 'latest', isDirty: false, revision: 3 })
  })

  it('copies a binary file as bytes, with its mime type', async () => {
    api.readInternalFile.mockResolvedValue({ content: 'AAEC', binary: true, mimeType: 'application/zip' })
    api.getInternalFiles.mockResolvedValue({ files: [{ path: 'data.zip' }] })
    api.writeInternalFiles.mockResolvedValue({ success: true, revisions: { 'data copy.zip': 1 } })

    await duplicateAgentFile('data.zip')

    expect(api.readInternalFile).toHaveBeenCalledWith('data.zip', { binaryContent: true })
    expect(api.writeInternalFiles).toHaveBeenCalledWith('/agents/a.adf', [{ path: 'data copy.zip', contentBase64: 'AAEC', mimeType: 'application/zip', mustNotExist: true }])
    expect(tab('data copy.zip')?.isBinary).toBe(true)
  })

  it('reports a binary file over the inline cap instead of writing an empty copy', async () => {
    api.readInternalFile.mockResolvedValue({ content: '', binary: true, tooLarge: true })

    await expect(duplicateAgentFile('big.zip')).resolves.toBe(false)
    expect(api.writeInternalFiles).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith('Could not duplicate big.zip', expect.objectContaining({ message: expect.stringMatching(/larger than/) }))
  })
})

describe('renameAgentFile', () => {
  it('saves first, then moves the tab in place with the new path\'s revision, without changing focus', async () => {
    const store = useEditorTabsStore.getState()
    store.openTab('a.md', 'saved', false)
    store.openTab('b.md', 'b', false)
    api.renameInternalFile.mockResolvedValue({ success: true })
    api.readInternalFile.mockResolvedValue({ content: '', binary: false, revision: 9 })

    await expect(renameAgentFile('a.md', 'docs/a.txt')).resolves.toBe(true)

    expect(saveFileNow).toHaveBeenCalledWith('a.md')
    expect(paths()).toEqual(['docs/a.txt', 'b.md'])
    expect(useEditorTabsStore.getState().activeTabPath).toBe('b.md')
    expect(tab('docs/a.txt')).toMatchObject({ content: 'saved', extension: 'txt', revision: 9 })
  })

  it('does not rename when the unsaved text could not be saved', async () => {
    saveFileNow.mockResolvedValue(false)

    await expect(renameAgentFile('a.md', 'b.md')).resolves.toBe(false)
    expect(api.renameInternalFile).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalled()
  })

  it('reloads the tab as binary when the new extension is not a text one, without activating it', async () => {
    const store = useEditorTabsStore.getState()
    store.openTab('raw.txt', 'bytes as text', false)
    store.openTab('other.md', '', false)
    api.renameInternalFile.mockResolvedValue({ success: true })
    api.readInternalFile
      .mockResolvedValueOnce({ content: '', binary: true })
      .mockResolvedValueOnce({ content: '', binary: true, mimeType: 'image/png', revision: 4 })

    await renameAgentFile('raw.txt', 'raw.png')

    expect(tab('raw.png')).toMatchObject({ isBinary: true, mimeType: 'image/png', content: '', revision: 4 })
    expect(useEditorTabsStore.getState().activeTabPath).toBe('other.md')
  })

  it('reports the refusal without the "Error: " both backends prefix, and leaves the tab', async () => {
    useEditorTabsStore.getState().openTab('a.md', 'x', false)
    api.renameInternalFile.mockResolvedValue({ success: false, error: 'Error: File already exists: b.md' })

    await expect(renameAgentFile('a.md', 'b.md')).resolves.toBe(false)
    expect(reportFailure).toHaveBeenCalledWith('Could not rename a.md', expect.objectContaining({ message: 'File already exists: b.md' }))
    expect(tab('a.md')).toBeDefined()
  })

  it('replaces a stale tab still open at the destination: one tab per path', async () => {
    const store = useEditorTabsStore.getState()
    store.openTab('x.md', 'deleted elsewhere', false)
    store.openTab('y.md', 'y', false)
    api.renameInternalFile.mockResolvedValue({ success: true })
    api.readInternalFile.mockResolvedValue({ content: '', binary: false })

    await renameAgentFile('y.md', 'x.md')

    expect(paths()).toEqual(['x.md'])
    expect(tab('x.md')?.content).toBe('y')
    expect(useEditorTabsStore.getState().activeTabPath).toBe('x.md')
  })
})

describe('renameAgentFile onto an open tab', () => {
  it('refuses when the tab at the destination has unsaved text', async () => {
    const store = useEditorTabsStore.getState()
    store.openTab('x.md', 'old', false)
    store.updateTabContent('x.md', 'never saved')
    store.openTab('y.md', 'y', false)

    await expect(renameAgentFile('y.md', 'x.md')).resolves.toBe(false)
    expect(api.renameInternalFile).not.toHaveBeenCalled()
    expect(tab('x.md')?.content).toBe('never saved')
  })

  it('takes the stored mime type of the renamed file', async () => {
    useEditorTabsStore.getState().openTab('a.png', '', true, 'image/png')
    api.renameInternalFile.mockResolvedValue({ success: true })
    api.readInternalFile.mockResolvedValue({ content: '', binary: true, mimeType: 'image/jpeg', revision: 2 })

    await renameAgentFile('a.png', 'a.jpg')

    expect(tab('a.jpg')).toMatchObject({ mimeType: 'image/jpeg', revision: 2, isBinary: true })
  })
})

describe('renameAgentFolder', () => {
  it('saves each open file in it, then moves only the tabs under it', async () => {
    const store = useEditorTabsStore.getState()
    store.openTab('src/a.md', '', false)
    store.openTab('src2/b.md', '', false)
    store.openTab('src/deep/c.md', '', false)
    api.renameFolder.mockResolvedValue({ success: true, count: 2 })
    api.readInternalFile.mockResolvedValue({ content: '', binary: false })

    await expect(renameAgentFolder('src', 'lib')).resolves.toBe(true)

    expect(saveFileNow.mock.calls.map((c) => c[0])).toEqual(['src/a.md', 'src/deep/c.md'])
    expect(paths()).toEqual(['lib/a.md', 'src2/b.md', 'lib/deep/c.md'])
    expect(useEditorTabsStore.getState().activeTabPath).toBe('lib/deep/c.md')
  })
})

describe('deleteAgentFile', () => {
  it('closes the tab only once the file is deleted', async () => {
    useEditorTabsStore.getState().openTab('a.md', '', false)
    api.deleteInternalFile.mockResolvedValue({ success: false })

    await expect(deleteAgentFile('a.md')).resolves.toBe(false)
    expect(tab('a.md')).toBeDefined()
    expect(reportFailure).toHaveBeenCalledWith('Could not delete a.md', expect.objectContaining({ message: expect.stringMatching(/protected/) }))

    api.deleteInternalFile.mockResolvedValue({ success: true })
    await expect(deleteAgentFile('a.md')).resolves.toBe(true)
    expect(tab('a.md')).toBeUndefined()
  })
})

describe('downloadAgentFile', () => {
  it('reports a missing file, and stays quiet when the save dialog is cancelled', async () => {
    api.downloadInternalFile.mockResolvedValue({ success: false, error: 'File not found' })
    await expect(downloadAgentFile('gone.zip')).resolves.toBe(false)
    expect(reportFailure).toHaveBeenCalledWith('Could not download gone.zip', expect.objectContaining({ message: 'File not found' }))

    reportFailure.mockReset()
    api.downloadInternalFile.mockResolvedValue({ success: false })
    await downloadAgentFile('data.zip')
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it('downloads the file on disk even when the tab\'s text could not be saved', async () => {
    saveFileNow.mockResolvedValue(false)
    api.downloadInternalFile.mockResolvedValue({ success: true })

    await expect(downloadAgentFile('notes.md')).resolves.toBe(true)
    expect(api.downloadInternalFile).toHaveBeenCalledWith('notes.md')
  })
})
