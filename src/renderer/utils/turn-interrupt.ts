import { openApi } from './runtime-api'

/**
 * The composer's Stop (and Esc, and `/stop`): end the running turn of
 * `loop` in the open agent, on that agent's runtime
 * (docs/design/multi-runtime.md §4.1; This computer's surface is
 * `window.adfApi`). Resolves with the refusal to show, or null when the
 * runtime took the interrupt.
 */
export async function interruptOpenTurn(filePath: string, loop: string): Promise<string | null> {
  try {
    const result = await openApi()?.interruptTurn(filePath, loop)
    if (!result) return 'no agent runtime'
    return result.success ? null : result.error ?? 'unknown error'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
