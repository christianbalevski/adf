import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../src/renderer/stores/app.store'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import { openAdfFileLink } from '../../../src/renderer/utils/open-adf-link'

const { readInternalFile, downloadInternalFile } = vi.hoisted(() => ({ readInternalFile: vi.fn(), downloadInternalFile: vi.fn() }))
vi.mock('../../../src/renderer/utils/runtime-api', () => ({
  openApi: () => ({ readInternalFile, downloadInternalFile }),
}))

beforeEach(() => {
  readInternalFile.mockReset()
  downloadInternalFile.mockReset()
  useEditorTabsStore.getState().reset()
  useAppStore.setState({ chatPlacement: 'center', centerChatTabActive: true })
})

describe('file links from the center Loops tab', () => {
  it('reveals the already active file, preserving unsaved edits', async () => {
    const store = useEditorTabsStore.getState()
    store.openTab('notes.md', 'saved', false)
    store.updateTabContent('notes.md', 'unsaved edit')

    await openAdfFileLink('adf-file://notes.md')

    expect(useAppStore.getState().centerChatTabActive).toBe(false)
    expect(useEditorTabsStore.getState().activeTabPath).toBe('notes.md')
    expect(useEditorTabsStore.getState().tabs).toHaveLength(1)
    expect(useEditorTabsStore.getState().tabs[0]).toMatchObject({ content: 'unsaved edit', isDirty: true })
    expect(readInternalFile).not.toHaveBeenCalled()

    // Returning to Loops and clicking the same link must work every time.
    useAppStore.getState().setCenterChatTabActive(true)
    await openAdfFileLink('adf-file://notes.md')
    expect(useAppStore.getState().centerChatTabActive).toBe(false)
  })

  it('selects and reveals another open file', async () => {
    const store = useEditorTabsStore.getState()
    store.openTab('notes.md', 'notes', false)
    store.openTab('README.md', 'readme', false)

    await openAdfFileLink('adf-file://notes.md')

    expect(useEditorTabsStore.getState().activeTabPath).toBe('notes.md')
    expect(useAppStore.getState().centerChatTabActive).toBe(false)
    expect(readInternalFile).not.toHaveBeenCalled()
  })

  it('reads and reveals a file that is not open yet', async () => {
    readInternalFile.mockResolvedValue({ content: 'report', binary: false, revision: 12 })

    await openAdfFileLink('adf-file://reports/my%20report.md')

    expect(readInternalFile).toHaveBeenCalledWith('reports/my report.md')
    expect(useEditorTabsStore.getState().activeTabPath).toBe('reports/my report.md')
    expect(useEditorTabsStore.getState().tabs[0]).toMatchObject({ content: 'report', revision: 12 })
    expect(useAppStore.getState().centerChatTabActive).toBe(false)
  })

  it('keeps Loops visible when the file cannot be read', async () => {
    readInternalFile.mockResolvedValue(null)

    await openAdfFileLink('adf-file://missing.md')

    expect(useEditorTabsStore.getState().tabs).toHaveLength(0)
    expect(useAppStore.getState().centerChatTabActive).toBe(true)
  })

  it('downloads a binary file no tab can show, leaving Loops in view', async () => {
    readInternalFile.mockResolvedValue({ content: '', binary: true, mimeType: 'application/pdf' })

    await openAdfFileLink('adf-file://out/report%20final.pdf')

    expect(downloadInternalFile).toHaveBeenCalledWith('out/report final.pdf')
    expect(useEditorTabsStore.getState().tabs).toHaveLength(0)
    expect(useAppStore.getState().centerChatTabActive).toBe(true)
  })

  it('downloads a binary file already open as a placeholder tab', async () => {
    useEditorTabsStore.getState().openTab('data.xlsx', '', true, 'application/octet-stream')

    await openAdfFileLink('adf-file://data.xlsx')

    expect(downloadInternalFile).toHaveBeenCalledWith('data.xlsx')
    expect(readInternalFile).not.toHaveBeenCalled()
  })

  it('still opens an image in its viewer tab', async () => {
    readInternalFile.mockResolvedValue({ content: '', binary: true, mimeType: 'image/png' })

    await openAdfFileLink('adf-file://chart.png')

    expect(downloadInternalFile).not.toHaveBeenCalled()
    expect(useEditorTabsStore.getState().activeTabPath).toBe('chart.png')
    expect(useAppStore.getState().centerChatTabActive).toBe(false)
  })
})
