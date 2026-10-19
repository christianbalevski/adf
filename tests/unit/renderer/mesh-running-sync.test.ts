/**
 * Whether the mesh runs (#149): every window reads it from the runtime, and a
 * read that started before a local change made in this window never undoes it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useMeshStore } from '../../../src/renderer/stores/mesh.store'

describe('mesh running state from the runtime', () => {
  beforeEach(() => useMeshStore.getState().reset())

  it('an agent window takes the runtime\'s answer: the mesh runs', () => {
    const rev = useMeshStore.getState().enabledRev
    useMeshStore.getState().syncEnabled(true, rev)
    expect(useMeshStore.getState().enabled).toBe(true)
  })

  it('the mesh turned off in another window is read as off', () => {
    useMeshStore.getState().setEnabled(true)
    const rev = useMeshStore.getState().enabledRev
    useMeshStore.getState().syncEnabled(false, rev)
    expect(useMeshStore.getState().enabled).toBe(false)
  })

  it('a read started before this window turned the mesh on does not turn it off', () => {
    const rev = useMeshStore.getState().enabledRev
    useMeshStore.getState().setEnabled(true)
    useMeshStore.getState().syncEnabled(false, rev)
    expect(useMeshStore.getState().enabled).toBe(true)
  })

  it('a read started before Kill does not turn the mesh back on', () => {
    useMeshStore.getState().setEnabled(true)
    const rev = useMeshStore.getState().enabledRev
    useMeshStore.getState().reset()
    useMeshStore.getState().syncEnabled(true, rev)
    expect(useMeshStore.getState().enabled).toBe(false)
  })
})
