import { describe, expect, it, vi } from 'vitest'
import { fileOperationErrorMessage, reportFileOperationError } from '../../../src/renderer/utils/file-operation-errors'

describe('renderer file-operation errors', () => {
  it('reports a create collision while leaving success/cancel silent', () => {
    const result = { success: false, error: 'ADF file already exists: /tmp/agent.adf' }
    expect(fileOperationErrorMessage('create', result)).toBe(
      'Failed to create file:\n\nADF file already exists: /tmp/agent.adf',
    )
    expect(fileOperationErrorMessage('create', { success: false, error: 'Cancelled' })).toBeNull()
    expect(fileOperationErrorMessage('create', { success: true })).toBeNull()

    const notify = vi.fn()
    expect(reportFileOperationError('create', result, notify)).toBe(true)
    expect(notify).toHaveBeenCalledWith('Failed to create file:\n\nADF file already exists: /tmp/agent.adf')
    expect(reportFileOperationError('create', { success: false, error: 'Cancelled' }, notify)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
