import { describe, expect, it, vi } from 'vitest'
import { recoverFileCreateCleanupFailure } from '../../../src/main/ipc/file-create-recovery'

describe('FILE_CREATE cleanup recovery ownership', () => {
  it('keeps mesh and workspace ownership when background adoption succeeded', () => {
    const unregisterMesh = vi.fn()
    const closeWorkspace = vi.fn()
    const clearForeground = vi.fn()

    const result = recoverFileCreateCleanupFailure({
      retainedByBackground: true,
      startInFlight: false,
      unregisterMesh,
      closeWorkspace,
      clearForeground,
    })

    expect(result).toEqual({
      foregroundDetached: true,
      retainedByBackground: true,
      workspaceCloseAttempted: false,
      workspaceCloseFailed: false,
      meshUnregistered: false,
    })
    expect(unregisterMesh).not.toHaveBeenCalled()
    expect(closeWorkspace).not.toHaveBeenCalled()
    expect(clearForeground).toHaveBeenCalledTimes(1)
  })

  it('does not close or unregister a workspace still owned by AGENT_START', () => {
    const unregisterMesh = vi.fn()
    const closeWorkspace = vi.fn()
    const clearForeground = vi.fn()

    const result = recoverFileCreateCleanupFailure({
      retainedByBackground: false,
      startInFlight: true,
      unregisterMesh,
      closeWorkspace,
      clearForeground,
    })

    expect(result).toEqual({
      foregroundDetached: true,
      retainedByBackground: false,
      workspaceCloseAttempted: false,
      workspaceCloseFailed: false,
      meshUnregistered: false,
    })
    expect(unregisterMesh).not.toHaveBeenCalled()
    expect(closeWorkspace).not.toHaveBeenCalled()
    expect(clearForeground).toHaveBeenCalledTimes(1)
  })

  it('unregisters and closes an ordinary main-owned foreground', () => {
    const unregisterMesh = vi.fn()
    const closeWorkspace = vi.fn()
    const clearForeground = vi.fn()

    const result = recoverFileCreateCleanupFailure({
      retainedByBackground: false,
      startInFlight: false,
      unregisterMesh,
      closeWorkspace,
      clearForeground,
    })

    expect(result).toEqual({
      foregroundDetached: true,
      retainedByBackground: false,
      workspaceCloseAttempted: true,
      workspaceCloseFailed: false,
      meshUnregistered: true,
    })
    expect(unregisterMesh).toHaveBeenCalledTimes(1)
    expect(closeWorkspace).toHaveBeenCalledTimes(1)
    expect(clearForeground).toHaveBeenCalledTimes(1)
  })

  it('clears foreground even when workspace close fails and reports the failure', () => {
    const recoveryErrors: unknown[] = []
    const closeError = new Error('workspace close failed')
    const clearForeground = vi.fn()

    const result = recoverFileCreateCleanupFailure({
      retainedByBackground: false,
      startInFlight: false,
      unregisterMesh: vi.fn(),
      closeWorkspace: () => { throw closeError },
      clearForeground,
      onRecoveryError: (error) => recoveryErrors.push(error),
    })

    expect(result.workspaceCloseAttempted).toBe(true)
    expect(result.workspaceCloseFailed).toBe(true)
    expect(result.foregroundDetached).toBe(true)
    expect(recoveryErrors).toEqual([closeError])
    expect(clearForeground).toHaveBeenCalledTimes(1)
  })
})
