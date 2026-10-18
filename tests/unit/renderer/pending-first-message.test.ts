import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../../src/renderer/stores/app.store'

beforeEach(() => {
  useAppStore.setState({ pendingFirstMessage: null })
})

describe('pending first message', () => {
  it('keeps attached files when the new agent claims the message', () => {
    const file = new File(['attachment'], 'notes.txt', { type: 'text/plain' })
    useAppStore.getState().setPendingFirstMessage({
      filePath: '/agents/new.adf',
      text: 'Review this file',
      files: [file]
    })

    const claimed = useAppStore.getState().takePendingFirstMessage('/agents/new.adf')

    expect(claimed).toEqual({ filePath: '/agents/new.adf', text: 'Review this file', files: [file] })
    expect(useAppStore.getState().pendingFirstMessage).toBeNull()
  })

  it('leaves a message for another file untouched', () => {
    const pending = { filePath: '/agents/one.adf', text: 'Hello' }
    useAppStore.getState().setPendingFirstMessage(pending)

    expect(useAppStore.getState().takePendingFirstMessage('/agents/two.adf')).toBeNull()
    expect(useAppStore.getState().pendingFirstMessage).toEqual(pending)
  })
})
