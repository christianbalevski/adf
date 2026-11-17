import type { AdfApi } from '../../preload/api'
import { SKILL_MANIFEST } from '../../shared/utils/skills-panel'
import { isCurrentAgentView, type AgentView } from './agent-view'

/** Compose existing file deletes; never continue a removal in another agent. */
export async function removeSkillPackage(
  manifest: string,
  view: AgentView,
  api: Pick<AdfApi, 'getInternalFiles' | 'deleteInternalFile'>,
  onDeleted: (path: string) => void,
): Promise<{ deleted: number; error?: string }> {
  let deleted = 0
  try {
    const name = SKILL_MANIFEST.exec(manifest)?.[1]
    if (!name || name === '.' || name === '..' || name.includes('\\')) throw new Error('Invalid skill folder.')
    const assertCurrent = () => {
      if (!view.filePath || !isCurrentAgentView(view)) throw new Error('Removal stopped because the open agent changed.')
    }
    assertCurrent()
    const { files } = await api.getInternalFiles()
    assertCurrent()
    const packageFiles = files.filter((file) => file.path.startsWith(`skills/${name}/`))
    const protectedFile = packageFiles.find((file) => file.protection && file.protection !== 'none')
    if (protectedFile) throw new Error(`Cannot remove protected file: ${protectedFile.path}. No files were removed.`)
    // Unindex the skill first, so a failed resource deletion cannot leave an
    // active skill referring to files we already removed. Stop on any failure.
    packageFiles.sort((a, b) => Number(b.path === manifest) - Number(a.path === manifest) || a.path.localeCompare(b.path))
    for (const file of packageFiles) {
      assertCurrent()
      const result = await api.deleteInternalFile(file.path)
      if (!result.success) throw new Error(`Could not delete ${file.path}.`)
      deleted++
      assertCurrent()
      onDeleted(file.path)
    }
    return { deleted }
  } catch (err) {
    return { deleted, error: err instanceof Error ? err.message : String(err) }
  }
}
