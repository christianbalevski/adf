// Daemon reads/writes for file targets, plus the per-agent path cache that
// slash-command completion reads synchronously.

import type { DaemonClient } from '../../api/client'
import type { FileListEntry } from '../../api/types'
import { looksBinary, type FileTarget } from './model'

export interface LoadedContent {
  target: FileTarget
  /** UTF-8 text, when the target is text. */
  text?: string
  /** Raw bytes, when binary. */
  bytes?: Uint8Array
  binary: boolean
  mime?: string | null
  size: number
  protection?: string
  authorized?: boolean
  updatedAt?: string
}

export async function loadTarget(client: DaemonClient, agentId: string, target: FileTarget): Promise<LoadedContent> {
  if (target.kind === 'document' || target.kind === 'mind') {
    const result = target.kind === 'document' ? await client.document(agentId) : await client.mind(agentId)
    const text = result.content ?? ''
    return { target, text, binary: false, mime: 'text/markdown', size: Buffer.byteLength(text, 'utf-8') }
  }
  const file = await client.file(agentId, target.path)
  const base = { target, mime: file.mime_type, size: file.size, protection: file.protection, authorized: file.authorized, updatedAt: file.updated_at }
  if (file.encoding === 'base64') {
    return { ...base, binary: true, bytes: Buffer.from(file.content_base64 ?? '', 'base64') }
  }
  const text = file.content ?? ''
  if (looksBinary(text)) return { ...base, binary: true, bytes: Buffer.from(text, 'utf-8') }
  return { ...base, text, binary: false }
}

export async function writeTarget(client: DaemonClient, agentId: string, target: FileTarget, text: string): Promise<void> {
  if (target.kind === 'document') await client.putDocument(agentId, text)
  else if (target.kind === 'mind') await client.putMind(agentId, text)
  else await client.writeFile(agentId, target.path, { content: text })
}

// --- path cache (for /open completion) --------------------------------------

const pathCache = new Map<string, FileListEntry[]>()

export function cacheFiles(agentId: string, files: FileListEntry[]): void {
  pathCache.set(agentId, files)
}

export function cachedFiles(agentId: string | null): FileListEntry[] | undefined {
  return agentId ? pathCache.get(agentId) : undefined
}

export async function listFiles(client: DaemonClient, agentId: string): Promise<FileListEntry[]> {
  const result = await client.files(agentId)
  cacheFiles(agentId, result.files)
  return result.files
}
