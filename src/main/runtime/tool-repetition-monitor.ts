import { createHash } from 'node:crypto'
import type { ContentBlock } from '../../shared/types/provider.types'

export interface ToolRepetitionObservation {
  period: number
  repetitions: number
  toolNames: string[]
}

interface BatchFingerprint {
  hash: string
  toolNames: string[]
}

const MAX_BATCH_BYTES = 1024 * 1024
const MAX_HISTORY = 9
const MAX_DEPTH = 64

/**
 * Observes repeated tool calls AND results, without deciding whether the work
 * is useful. Retains only hashes and tool names; arguments and results never
 * become notice text. Incomplete or unsupported observations break the chain.
 */
export class ToolRepetitionMonitor {
  private history: BatchFingerprint[] = []
  private reportedPattern: string | null = null

  reset(): void {
    this.history = []
    this.reportedPattern = null
  }

  observe(toolUses: readonly ContentBlock[], toolResults: readonly ContentBlock[]): ToolRepetitionObservation | null {
    const batch = fingerprint(toolUses, toolResults)
    if (!batch) {
      this.reset()
      return null
    }
    this.history.push(batch)
    if (this.history.length > MAX_HISTORY) this.history.shift()

    for (let period = 1; period <= 3; period++) {
      if (this.history.length < period * 3) continue
      const end = this.history.length
      let repetitions = 1
      while ((repetitions + 1) * period <= end) {
        const same = this.history.slice(end - period, end).every((item, index) =>
          item.hash === this.history[end - (repetitions + 1) * period + index].hash)
        if (!same) break
        repetitions++
      }
      if (repetitions < 3) continue

      const cycle = this.history.slice(end - period, end)
      const hashes = cycle.map(item => item.hash)
      // ABABAB and BABABA are the same continuing cycle, not two notices.
      const pattern = hashes.map((_, index) =>
        [...hashes.slice(index), ...hashes.slice(0, index)].join(':')).sort()[0]
      if (this.reportedPattern === pattern) return null
      this.reportedPattern = pattern
      return { period, repetitions, toolNames: [...new Set(cycle.flatMap(item => item.toolNames))] }
    }
    this.reportedPattern = null
    return null
  }
}

function fingerprint(uses: readonly ContentBlock[], results: readonly ContentBlock[]): BatchFingerprint | null {
  if (uses.length === 0 || uses.length !== results.length) return null
  const hash = createHash('sha256')
  let bytes = 0
  let nodes = 0
  const ancestors = new Set<object>()
  const write = (text: string): void => {
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_BATCH_BYTES) throw new Error('oversized observation')
    hash.update(text)
  }
  const string = (value: string): void => {
    // Bound the input before JSON escaping allocates another copy.
    if (Buffer.byteLength(value) > MAX_BATCH_BYTES - bytes) throw new Error('oversized observation')
    write(JSON.stringify(value))
  }
  const value = (input: unknown, depth = 0, inputRoot = false): void => {
    if (++nodes > 50_000 || depth > MAX_DEPTH) throw new Error('complex observation')
    if (input === null) { write('null'); return }
    if (typeof input === 'string') { string(input); return }
    if (typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) {
      write(JSON.stringify(input)); return
    }
    if (typeof input !== 'object' || ancestors.has(input)) throw new Error('non-JSON observation')
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new Error('non-JSON observation')
    }
    ancestors.add(input)
    if (Array.isArray(input)) {
      if (input.length > 50_000) throw new Error('complex observation')
      write('[')
      for (let index = 0; index < input.length; index++) {
        if (!Object.hasOwn(input, index)) throw new Error('sparse observation')
        if (index) write(',')
        value(input[index], depth + 1)
      }
      write(']')
    } else {
      write('{')
      const keys = Object.keys(input).filter(key => !inputRoot || key !== '_reason').sort()
      for (const [index, key] of keys.entries()) {
        if (index) write(',')
        string(key)
        write(':')
        value((input as Record<string, unknown>)[key], depth + 1)
      }
      write('}')
    }
    ancestors.delete(input)
  }

  try {
    const seenIds = new Set<string>()
    const resultsById = new Map<string, ContentBlock>()
    for (const result of results) {
      if (result.type !== 'tool_result' || !result.tool_use_id || typeof result.content !== 'string'
        || resultsById.has(result.tool_use_id) || result.interrupted
        || result.image_url || result.input_audio || result.video_url || result.file_ref) return null
      resultsById.set(result.tool_use_id, result)
    }
    write('[')
    for (const [index, use] of uses.entries()) {
      if (use.type !== 'tool_use' || !use.id || !use.name || seenIds.has(use.id) || use.interrupted) return null
      seenIds.add(use.id)
      const result = resultsById.get(use.id)
      if (!result) return null
      if (index) write(',')
      write('[')
      string(use.name)
      write(',')
      value(use.input, 0, true)
      write(',')
      string(result.content!)
      write(result.is_error === true ? ',true]' : ',false]')
    }
    write(']')
    return { hash: hash.digest('hex'), toolNames: [...new Set(uses.map(use => use.name!))] }
  } catch {
    return null
  }
}
