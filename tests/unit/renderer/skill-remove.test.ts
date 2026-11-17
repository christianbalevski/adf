import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdfApi } from '../../../src/preload/api'
import { captureAgentView } from '../../../src/renderer/utils/agent-view'
import { removeSkillPackage } from '../../../src/renderer/utils/skill-remove'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'

const manifest = 'skills/example/SKILL.md'
const resource = 'skills/example/resources/guide.md'
const sibling = 'skills/example-other/SKILL.md'
const closed = vi.fn()
function api(paths = [resource, sibling, manifest]) {
  return {
    getInternalFiles: vi.fn<AdfApi['getInternalFiles']>().mockResolvedValue({
      files: paths.map((path) => ({ path, size: 1, protection: 'none', authorized: false, created_at: '', updated_at: '' })),
    }),
    deleteInternalFile: vi.fn<AdfApi['deleteInternalFile']>().mockResolvedValue({ success: true }),
  }
}

beforeEach(() => {
  closed.mockClear()
  useDocumentStore.getState().reset()
  useDocumentStore.getState().setFilePath('/a.adf', 'local')
})

describe('skill package removal', () => {
  it('removes only the exact package, with the manifest first', async () => {
    const backend = api()
    expect(await removeSkillPackage(manifest, captureAgentView(), backend, closed)).toEqual({ deleted: 2 })
    expect(backend.deleteInternalFile.mock.calls).toEqual([[manifest], [resource]])
    expect(closed.mock.calls).toEqual([[manifest], [resource]])
  })

  it('stops before any deletes if the agent changes during listing, including away and back', async () => {
    const backend = api()
    const view = captureAgentView()
    backend.getInternalFiles.mockImplementation(async () => {
      useDocumentStore.getState().setFilePath('/b.adf', 'local')
      useDocumentStore.getState().setFilePath('/a.adf', 'local')
      return { files: [] }
    })
    expect(await removeSkillPackage(manifest, view, backend, closed)).toMatchObject({ deleted: 0, error: expect.stringContaining('agent changed') })
    expect(backend.deleteInternalFile).not.toHaveBeenCalled()
  })

  it('stops after an in-flight delete if the view changes and leaves new tabs alone', async () => {
    const backend = api()
    backend.deleteInternalFile.mockImplementation(async () => {
      useDocumentStore.getState().setFilePath('/b.adf', 'local')
      return { success: true }
    })
    expect(await removeSkillPackage(manifest, captureAgentView(), backend, closed)).toMatchObject({ deleted: 1, error: expect.stringContaining('agent changed') })
    expect(backend.deleteInternalFile.mock.calls).toEqual([[manifest]])
    expect(closed).not.toHaveBeenCalled()
  })

  it('keeps resources when deleting the manifest is refused', async () => {
    const backend = api()
    backend.deleteInternalFile.mockResolvedValueOnce({ success: false })
    expect(await removeSkillPackage(manifest, captureAgentView(), backend, closed)).toEqual({ deleted: 0, error: `Could not delete ${manifest}.` })
    expect(backend.deleteInternalFile.mock.calls).toEqual([[manifest]])
    expect(closed).not.toHaveBeenCalled()
  })

  it('reports partial deletion accurately on a failed resource delete', async () => {
    const backend = api()
    backend.deleteInternalFile.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('connection lost'))
    expect(await removeSkillPackage(manifest, captureAgentView(), backend, closed)).toEqual({ deleted: 1, error: 'connection lost' })
    expect(closed.mock.calls).toEqual([[manifest]])
  })

  it.each(['skills/../SKILL.md', 'skills/./SKILL.md', 'skills-state.json'])('refuses a non-package path: %s', async (path) => {
    const backend = api()
    expect(await removeSkillPackage(path, captureAgentView(), backend, closed)).toEqual({ deleted: 0, error: 'Invalid skill folder.' })
    expect(backend.getInternalFiles).not.toHaveBeenCalled()
    expect(backend.deleteInternalFile).not.toHaveBeenCalled()
  })
})
