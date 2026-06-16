import { importOpenClaw } from './openclaw'
import { importHermes } from './hermes'
import { emitAdf, type EmitOutcome } from './emit'
import type { ImportResult } from './types'

export type ImportSourceKind = 'openclaw' | 'hermes'

export const SUPPORTED_SOURCES: ImportSourceKind[] = ['openclaw', 'hermes']

export interface RunImportOptions {
  from: ImportSourceKind
  srcPath: string
  outPath: string
  name?: string
  force?: boolean
}

const ADAPTERS: Record<ImportSourceKind, (o: { srcPath: string; name?: string }) => ImportResult> = {
  openclaw: importOpenClaw,
  hermes: importHermes,
}

/** Parse a source agent and write it out as a `.adf`. */
export function runImport(opts: RunImportOptions): EmitOutcome {
  const adapter = ADAPTERS[opts.from]
  if (!adapter) {
    throw new Error(`Unknown source "${opts.from}". Supported: ${SUPPORTED_SOURCES.join(', ')}`)
  }
  const result = adapter({ srcPath: opts.srcPath, name: opts.name })
  return emitAdf(result, opts.outPath, { force: opts.force })
}

/** Human-readable conversion report. */
export function formatImportReport(from: ImportSourceKind, outcome: EmitOutcome): string {
  const lines = [
    `Imported ${from} agent → ${outcome.path}`,
    `  name:  ${outcome.name}`,
    `  id:    ${outcome.id}`,
    `  files: ${outcome.files} seeded`,
    `  loop:  ${outcome.loopEntries} message(s)`,
  ]
  if (outcome.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const w of outcome.warnings) lines.push(`  • ${w}`)
  }
  return lines.join('\n') + '\n'
}

export { emitAdf } from './emit'
export type { ImportResult } from './types'
