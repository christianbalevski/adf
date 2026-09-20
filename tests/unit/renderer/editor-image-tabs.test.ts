import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'

describe('image tabs in the editor store', () => {
  beforeEach(() => useEditorTabsStore.getState().reset())

  it('keeps the stored mime type and no content, and is never dirty', () => {
    useEditorTabsStore.getState().openTab('chart', '', true, 'image/png')
    const tab = useEditorTabsStore.getState().tabs[0]
    expect(tab).toMatchObject({ path: 'chart', content: '', isBinary: true, mimeType: 'image/png', isDirty: false })
  })

  it('picks up a changed type when the file is opened again', () => {
    const store = useEditorTabsStore.getState()
    store.openTab('out.bin', '', true, 'application/octet-stream')
    store.openTab('out.bin', '', true, 'image/gif')
    expect(useEditorTabsStore.getState().tabs).toHaveLength(1)
    expect(useEditorTabsStore.getState().tabs[0].mimeType).toBe('image/gif')
  })
})
