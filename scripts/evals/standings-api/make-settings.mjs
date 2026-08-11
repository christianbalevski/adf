/**
 * Build an isolated daemon settings file for the standings-api eval.
 *
 * Copies ONLY the providers from the user's real ADF Studio settings (keys and
 * all — the daemon needs them to construct the LLM provider), empties
 * trackedDirectories so the daemon autostarts nothing, enables mesh, and
 * registers the playwright MCP server so the per-agent registry check passes.
 *
 * Usage: node scripts/evals/standings-api/make-settings.mjs --out <path.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`Missing --${name}`)
  return process.argv[i + 1]
}

const out = arg('out')
const meshPortIdx = process.argv.indexOf('--mesh-port')
const meshPort = meshPortIdx !== -1 ? Number(process.argv[meshPortIdx + 1]) : 7296
const appData = process.env.APPDATA
const candidates = [
  join(appData, 'ADF Studio', 'adf-settings.json'),
  join(appData, 'adf-studio', 'adf-settings.json'),
]

let source
for (const p of candidates) {
  try {
    source = JSON.parse(readFileSync(p, 'utf8'))
    break
  } catch { /* try next */ }
}
if (!source) throw new Error(`No ADF settings found in: ${candidates.join(', ')}`)

const settings = {
  providers: source.providers ?? [],
  defaultProvider: source.defaultProvider,
  // Not 7295: a dev Studio may hold the default mesh port; the eval daemon
  // gets its own so discovery and serving never cross runtimes.
  meshEnabled: true,
  meshPort,
  trackedDirectories: [],
  mcpServers: [
    {
      id: 'playwright',
      name: 'playwright',
      type: 'npm',
      npmPackage: '@playwright/mcp',
    },
  ],
}

writeFileSync(out, JSON.stringify(settings, null, 2))
console.log(`eval settings written: ${out} (providers: ${settings.providers.length})`)
