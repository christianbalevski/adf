/**
 * Characterization of TEMPLATE_ADD_FILES' naming and refusals (embedded
 * AgentTemplatesService.addFiles, E1 extraction into stageTemplateAddFiles,
 * which the daemon's POST /templates/:id/files/plan runs too): whole batch
 * or nothing, items checked in pick order, a stat failure, a non-file, a
 * file over 25 MB or an unusable name ends the batch with that item's
 * sentence; a name the template already uses is numbered (case-sensitive),
 * a reserved seed name the template lacks is refused (case-insensitive).
 */
import { describe, expect, it } from 'vitest'
import { stageTemplateAddFiles } from '../../../src/main/adf/agent-templates'

const file = (name: string, size = 10) => ({ name, isFile: true, size })

describe('stageTemplateAddFiles (E1)', () => {
  it('numbers names already taken, earlier picks included', () => {
    expect(stageTemplateAddFiles(new Set(['README.md', 'mind.md', 'soul.md', 'report.pdf']), [file('report.pdf'), file('report.pdf'), file('notes.txt')]))
      .toEqual({ dests: ['report-2.pdf', 'report-3.pdf', 'notes.txt'] })
  })

  it('a reserved seed name is numbered when the template has that file, refused when it does not', () => {
    expect(stageTemplateAddFiles(new Set(['README.md']), [file('README.md')])).toEqual({ dests: ['README-2.md'] })
    expect(stageTemplateAddFiles(new Set(['README.md']), [file('readme.md')])).toEqual({ error: 'readme.md: readme.md is created by the agent itself.' })
    expect(stageTemplateAddFiles(new Set<string>(), [file('a.txt'), file('soul.md')])).toEqual({ error: 'soul.md: soul.md is created by the agent itself.' })
  })

  it('refusals in pick order: stat failure, not a file, too large', () => {
    expect(stageTemplateAddFiles(new Set<string>(), [{ name: 'gone.txt', statError: 'ENOENT: no such file' }, { name: 'dir', isFile: false, size: 0 }]))
      .toEqual({ error: 'ENOENT: no such file' })
    expect(stageTemplateAddFiles(new Set<string>(), [file('a.txt'), { name: 'dir', isFile: false, size: 0 }])).toEqual({ error: 'dir is not a file.' })
    expect(stageTemplateAddFiles(new Set<string>(), [file('big.bin', 25 * 1024 * 1024 + 1)])).toEqual({ error: 'big.bin is larger than 25 MB.' })
  })
})
