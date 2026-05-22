import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getUserDataPath } from '../utils/user-data-path'

/**
 * Token usage data structure:
 * {
 *   "2026-02-01": {
 *     "anthropic": {
 *       "claude-sonnet-4-5": { "input": 12345, "output": 6789 },
 *       "claude-opus-4": { "input": 8000, "output": 4000 }
 *     },
 *     "openai": {
 *       "gpt-4": { "input": 5000, "output": 3000 }
 *     }
 *   }
 * }
 */

export interface TokenUsageData {
  [date: string]: {
    [provider: string]: {
      [model: string]: {
        input: number
        output: number
      }
    }
  }
}

export class TokenUsageService {
  private filePath: string
  private data: TokenUsageData = {}
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly SAVE_DEBOUNCE_MS = 5000

  constructor() {
    const userDataPath = getUserDataPath()
    this.filePath = join(userDataPath, 'token-usage.json')
    this.load()
  }

  /**
   * Load token usage data from disk
   */
  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        this.data = JSON.parse(raw)
      }
    } catch (err) {
      console.error('[TokenUsage] Failed to load token usage data:', err)
      this.data = {}
    }
  }

  /**
   * Schedule a debounced save. Coalesces rapid writes into one disk I/O.
   */
  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.dirty) {
        this.dirty = false
        this.saveNow()
      }
    }, TokenUsageService.SAVE_DEBOUNCE_MS)
  }

  /**
   * Immediately write token usage data to disk.
   */
  private saveNow(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('[TokenUsage] Failed to save token usage data:', err)
    }
  }

  /**
   * Flush pending writes immediately. Call on app quit.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.dirty) {
      this.dirty = false
      this.saveNow()
    }
  }

  /**
   * Record token usage for a specific provider, model, and date
   */
  recordUsage(provider: string, model: string, inputTokens: number, outputTokens: number): void {
    // Get current date in YYYY-MM-DD format
    const date = new Date().toISOString().split('T')[0]

    // Initialize nested structure if needed
    if (!this.data[date]) {
      this.data[date] = {}
    }
    if (!this.data[date][provider]) {
      this.data[date][provider] = {}
    }
    if (!this.data[date][provider][model]) {
      this.data[date][provider][model] = { input: 0, output: 0 }
    }

    // Increment token counts
    this.data[date][provider][model].input += inputTokens
    this.data[date][provider][model].output += outputTokens

    // Debounced save to disk
    this.scheduleSave()
  }

  /**
   * Get all token usage data
   */
  getUsageData(): TokenUsageData {
    return this.data
  }

  /**
   * Get token usage for a specific date
   */
  getUsageByDate(date: string): TokenUsageData[string] | undefined {
    return this.data[date]
  }

  /**
   * Clear all token usage data
   */
  clearAll(): void {
    this.data = {}
    this.flush() // Clear any pending debounced save
    this.saveNow()
  }

  /**
   * Compact summary used by the home dashboard:
   *  - today's input/output totals across all providers/models
   *  - all-time input/output totals
   *  - top model (most cumulative tokens) all-time, with its total
   */
  getSummary(): {
    today: { input: number; output: number }
    allTime: { input: number; output: number }
    topModel: { provider: string; model: string; total: number } | null
  } {
    const today = new Date().toISOString().split('T')[0]
    const todayTotals = { input: 0, output: 0 }
    const allTimeTotals = { input: 0, output: 0 }
    // model key → { provider, model, total }
    const perModel = new Map<string, { provider: string; model: string; total: number }>()

    for (const [date, byProvider] of Object.entries(this.data)) {
      for (const [provider, byModel] of Object.entries(byProvider)) {
        for (const [model, { input, output }] of Object.entries(byModel)) {
          allTimeTotals.input += input
          allTimeTotals.output += output
          if (date === today) {
            todayTotals.input += input
            todayTotals.output += output
          }
          const key = `${provider}::${model}`
          const existing = perModel.get(key)
          const total = (existing?.total ?? 0) + input + output
          perModel.set(key, { provider, model, total })
        }
      }
    }

    let topModel: { provider: string; model: string; total: number } | null = null
    for (const entry of perModel.values()) {
      if (!topModel || entry.total > topModel.total) topModel = entry
    }

    return { today: todayTotals, allTime: allTimeTotals, topModel }
  }
}

// Singleton instance
let instance: TokenUsageService | null = null

export function getTokenUsageService(): TokenUsageService {
  if (!instance) {
    instance = new TokenUsageService()
  }
  return instance
}
