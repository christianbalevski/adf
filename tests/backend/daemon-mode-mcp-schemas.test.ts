/**
 * daemon-mode/mcp/schemas.ts copies the argument schemas of the embedded
 * MCP and adapter handlers (they live inside registerAllIpcHandlers, and
 * only W3-A extracts from ipc/index.ts, E1). Until that extraction, this
 * test holds each copy to its original, source text against source text,
 * so an edit to one side fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../..')
const IPC_SOURCE = readFileSync(join(ROOT, 'src/main/ipc/index.ts'), 'utf-8')
const COPY_SOURCE = readFileSync(join(ROOT, 'src/main/backend/daemon-mode/mcp/schemas.ts'), 'utf-8')

/** The balanced `z.object(...)` expression starting at `from`. */
function zObjectAt(source: string, from: number): string {
  const start = source.indexOf('z.object(', from)
  if (start < 0) throw new Error('no z.object')
  let depth = 0
  for (let i = start + 'z.object'.length; i < source.length; i++) {
    const c = source[i]
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error('unbalanced z.object')
}

/** Comments, whitespace and trailing commas do not count. */
function norm(expr: string): string {
  return expr
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
    .replace(/,([}\])])/g, '$1')
}

function copy(name: string): string {
  const at = COPY_SOURCE.indexOf(`export const ${name} = `)
  if (at < 0) throw new Error(`no copy ${name}`)
  return norm(zObjectAt(COPY_SOURCE, at))
}

/** `const Name = z.object(...)` in ipc/index.ts. */
function namedOriginal(name: string): string {
  const at = IPC_SOURCE.indexOf(`const ${name} = z.object(`)
  if (at < 0) throw new Error(`no original ${name}`)
  return norm(zObjectAt(IPC_SOURCE, at))
}

/** The first `z.object(...)` inside the embedded handler of `channel`. */
function inlineOriginal(channel: string): string {
  const at = IPC_SOURCE.indexOf(`ipcMain.handle(IPC.${channel},`)
  if (at < 0) throw new Error(`no handler ${channel}`)
  return norm(zObjectAt(IPC_SOURCE, at))
}

describe('daemon-mode MCP and adapter argument schemas equal the embedded ones', () => {
  it.each(['McpPackageArgs', 'McpUninstallArgs', 'McpNameArgs', 'McpCredentialSetArgs', 'McpCredentialGetArgs', 'McpCredentialListArgs', 'McpAttachArgs', 'McpDetachArgs'])('%s', (name) => {
    expect(copy(name)).toBe(namedOriginal(name))
  })

  it.each([
    ['AdapterPackageArgs', 'ADAPTER_INSTALL_PACKAGE'],
    ['AdapterPackageArgs', 'ADAPTER_UNINSTALL_PACKAGE'],
    ['AdapterTypeArgs', 'ADAPTER_RESTART'],
    ['AdapterTypeArgs', 'ADAPTER_GET_LOGS'],
    ['AdapterCredentialSetArgs', 'ADAPTER_CREDENTIAL_SET'],
    ['AdapterCredentialGetArgs', 'ADAPTER_CREDENTIAL_GET'],
    ['AdapterListFilesArgs', 'ADAPTER_CREDENTIAL_LIST_FILES'],
    ['AdapterAttachArgs', 'ADAPTER_ATTACH'],
    ['AdapterDetachArgs', 'ADAPTER_DETACH'],
  ])('%s (%s)', (name, channel) => {
    expect(copy(name)).toBe(inlineOriginal(channel))
  })
})
