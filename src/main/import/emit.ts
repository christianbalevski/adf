import { existsSync } from 'fs'
import { AdfWorkspace } from '../adf/adf-workspace'
import type { ImportResult } from './types'

export interface EmitOptions {
  /** Overwrite the output file if it already exists. */
  force?: boolean
}

export interface EmitOutcome {
  path: string
  id: string
  name: string
  files: number
  loopEntries: number
  warnings: string[]
  notTransferred: string[]
}

/**
 * Materialize a normalized ImportResult into a `.adf` file on disk.
 * Everything that isn't part of CreateAgentOptions — long-term memory,
 * reference files, conversation history — is seeded after creation.
 */
export function emitAdf(result: ImportResult, outPath: string, opts: EmitOptions = {}): EmitOutcome {
  if (existsSync(outPath) && !opts.force) {
    throw new Error(`Refusing to overwrite existing file: ${outPath} (use --force)`)
  }

  const ws = AdfWorkspace.create(outPath, result.options)
  try {
    if (result.mind && result.mind.trim() !== '') {
      ws.writeMind(result.mind)
    }
    for (const file of result.files) {
      ws.writeFile(file.path, file.content)
    }
    for (const entry of result.loop) {
      ws.appendToLoop(entry.role, [{ type: 'text', text: entry.text }])
    }
    // Record provenance so a round-trip is traceable.
    ws.setMeta('adf_import_source', result.source)

    const config = ws.getAgentConfig()
    return {
      path: outPath,
      id: config.id,
      name: config.name,
      files: result.files.length,
      loopEntries: result.loop.length,
      warnings: result.warnings,
      notTransferred: result.notTransferred,
    }
  } finally {
    ws.close()
  }
}
