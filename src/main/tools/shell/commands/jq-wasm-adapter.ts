/**
 * Adapter around jq-wasm (real jq 1.8.2 compiled to WebAssembly).
 *
 * Isolation seam: keeps the third-party import out of structured.ts so the
 * implementation can be mocked in tests or switched to 'jq-wasm/inline'
 * (embedded wasm bytes) if fs-based loading ever fails in a packaged build.
 */

export interface JqRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

let jqModule: Promise<typeof import('jq-wasm')> | null = null

/**
 * Run a jq filter over input text. Flags are CLI-style (e.g. ['-r', '-c']).
 * Never throws on jq errors — inspect exitCode. The wasm module initializes
 * lazily on first call and is cached for the process lifetime.
 */
export async function runJq(
  input: string,
  filter: string,
  flags: string[] = []
): Promise<JqRunResult> {
  if (!jqModule) jqModule = import('jq-wasm')
  const jq = await jqModule
  return jq.raw(input, filter, flags)
}
