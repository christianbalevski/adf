/**
 * Which agent files carry credentials for an MCP server, a channel adapter
 * or a provider: the Settings pages' "agents using this" lists.
 *
 * Shared by Studio's *_CREDENTIAL_LIST_FILES handlers and the daemon's
 * /credentials/* routes. Metadata only: each entry names the credential keys
 * a file holds (`populatedKeys`), never their values. Reads go through the
 * readonly AdfDatabase.peek* helpers, so no file is opened for writing.
 *
 * Files come from `knownFiles` (the agents the host has open) first, then a
 * walk of each tracked directory, depth 0..3, skipping dot folders and
 * node_modules. A file is listed once. Files and folders that cannot be read
 * are skipped.
 *
 * Two walks, one per-file check: Studio's handlers use the synchronous walk
 * (as before the extraction); the daemon uses the `*Async` walk, which reads
 * directories asynchronously and yields to the event loop after every file,
 * so a scan of a large tracked tree never blocks other clients or the
 * agents. Each file's peek (a short readonly SQLite open) is the only
 * synchronous step between yields. Both walks visit files in the same order.
 */

import { readdirSync } from 'fs'
import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { AdfDatabase } from '../adf/adf-database'
import type { ProviderCredentialFileInfo } from '../../shared/types/ipc.types'

export interface CredentialFileInfo {
  filePath: string
  fileName: string
  hasCredentials: boolean
  populatedKeys: string[]
}

export interface CredentialFileSources {
  /** Files the host has open (foreground, background, loaded): checked first. */
  knownFiles: string[]
  /** settings.trackedDirectories. */
  trackedDirs: string[]
}

/** One file's entry, or null when it neither holds credentials nor references the target. Throws on an unreadable file. */
type FileCheck<T> = (filePath: string) => T | null

const MAX_DEPTH = 3
const isAdf = (e: { isFile(): boolean; name: string }) => e.isFile() && e.name.endsWith('.adf')
const isWalkable = (e: { isDirectory(): boolean; name: string }) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'

function collectSync<T>(sources: CredentialFileSources, check: FileCheck<T>): T[] {
  const results: T[] = []
  const seen = new Set<string>()
  const checkFile = (filePath: string): void => {
    if (seen.has(filePath)) return
    seen.add(filePath)
    try {
      const entry = check(filePath)
      if (entry) results.push(entry)
    } catch {
      // Skip files that can't be read
    }
  }

  for (const filePath of sources.knownFiles) checkFile(filePath)

  for (const dir of sources.trackedDirs) {
    try {
      const scanFiles = (dirPath: string, depth: number) => {
        if (depth > MAX_DEPTH) return
        const entries = readdirSync(dirPath, { withFileTypes: true })
        for (const e of entries) {
          if (isAdf(e)) {
            checkFile(join(dirPath, e.name))
          } else if (isWalkable(e)) {
            scanFiles(join(dirPath, e.name), depth + 1)
          }
        }
      }
      scanFiles(dir, 0)
    } catch {
      // Skip dirs that can't be read
    }
  }
  return results
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function collectAsync<T>(sources: CredentialFileSources, check: FileCheck<T>): Promise<T[]> {
  const results: T[] = []
  const seen = new Set<string>()
  const checkFile = async (filePath: string): Promise<void> => {
    if (seen.has(filePath)) return
    seen.add(filePath)
    try {
      const entry = check(filePath)
      if (entry) results.push(entry)
    } catch {
      // Skip files that can't be read
    }
    await yieldToEventLoop()
  }

  for (const filePath of sources.knownFiles) await checkFile(filePath)

  for (const dir of sources.trackedDirs) {
    // Same as the sync walk: an unreadable directory stops this tracked
    // root's walk where it is; files already found are kept.
    try {
      const scanFiles = async (dirPath: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) return
        const entries = await readdir(dirPath, { withFileTypes: true })
        for (const e of entries) {
          if (isAdf(e)) {
            await checkFile(join(dirPath, e.name))
          } else if (isWalkable(e)) {
            await scanFiles(join(dirPath, e.name), depth + 1)
          }
        }
      }
      await scanFiles(dir, 0)
    } catch {
      // Skip dirs that can't be read
    }
  }
  return results
}

/** `mcp:<npmPackage>:*` credentials, else the server named in the config. */
function mcpCheck(args: { mcpServerName: string; npmPackage: string }): FileCheck<CredentialFileInfo> {
  const prefix = `mcp:${args.npmPackage}:`
  return (filePath) => {
    const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
    const populatedKeys = purposes.map((p) => p.slice(prefix.length))

    // Include if file has stored credentials for this server
    if (populatedKeys.length > 0) {
      return { filePath, fileName: basename(filePath), hasCredentials: true, populatedKeys }
    }

    // Also include if the file references this MCP server in its config (even without creds yet)
    const mcpNames = AdfDatabase.peekMcpServerNames(filePath)
    if (mcpNames.includes(args.mcpServerName)) {
      return { filePath, fileName: basename(filePath), hasCredentials: false, populatedKeys: [] }
    }
    return null
  }
}

/** `adapter:<type>:*` credentials, else the adapter configured. */
function adapterCheck(adapterType: string): FileCheck<CredentialFileInfo> {
  const prefix = `adapter:${adapterType}:`
  return (filePath) => {
    const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
    const populatedKeys = purposes.map((p) => p.slice(prefix.length))

    // Include if file has stored credentials for this adapter
    if (populatedKeys.length > 0) {
      return { filePath, fileName: basename(filePath), hasCredentials: true, populatedKeys }
    }

    // Also include if the file references this adapter type in its config
    const adapterTypes = AdfDatabase.peekAdapterTypes(filePath)
    if (adapterTypes.includes(adapterType)) {
      return { filePath, fileName: basename(filePath), hasCredentials: false, populatedKeys: [] }
    }
    return null
  }
}

/** `provider:<id>:*` credentials, else a copy of the provider in the config. */
function providerCheck(providerId: string): FileCheck<ProviderCredentialFileInfo> {
  const prefix = `provider:${providerId}:`
  return (filePath) => {
    const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
    const populatedKeys = purposes.map((p) => p.slice(prefix.length))
    // The agent's copy of the provider (no secrets): the renderer compares
    // it to the app values to tell a real override from Studio's unchanged
    // copy-on-create.
    const copy = AdfDatabase.peekProviderConfig(filePath, providerId)
    const providerConfig = copy
      ? { defaultModel: copy.defaultModel, params: copy.params, requestDelayMs: copy.requestDelayMs }
      : undefined

    if (populatedKeys.length > 0) {
      return { filePath, fileName: basename(filePath), hasCredentials: true, populatedKeys, providerConfig }
    }

    // Also include if the file references this provider in its config
    if (copy) {
      return { filePath, fileName: basename(filePath), hasCredentials: false, populatedKeys: [], providerConfig }
    }
    return null
  }
}

/** Files holding `mcp:<npmPackage>:*` credentials or naming the server in their config. */
export function listMcpCredentialFiles(
  args: { mcpServerName: string; npmPackage: string },
  sources: CredentialFileSources,
): { files: CredentialFileInfo[] } {
  return { files: collectSync(sources, mcpCheck(args)) }
}

/** Files holding `adapter:<type>:*` credentials or configuring the adapter. */
export function listAdapterCredentialFiles(adapterType: string, sources: CredentialFileSources): { files: CredentialFileInfo[] } {
  return { files: collectSync(sources, adapterCheck(adapterType)) }
}

/** Files holding `provider:<id>:*` credentials or a copy of the provider in their config. */
export function listProviderCredentialFiles(providerId: string, sources: CredentialFileSources): { files: ProviderCredentialFileInfo[] } {
  return { files: collectSync(sources, providerCheck(providerId)) }
}

/** listMcpCredentialFiles without blocking the event loop (daemon). */
export async function listMcpCredentialFilesAsync(
  args: { mcpServerName: string; npmPackage: string },
  sources: CredentialFileSources,
): Promise<{ files: CredentialFileInfo[] }> {
  return { files: await collectAsync(sources, mcpCheck(args)) }
}

/** listAdapterCredentialFiles without blocking the event loop (daemon). */
export async function listAdapterCredentialFilesAsync(adapterType: string, sources: CredentialFileSources): Promise<{ files: CredentialFileInfo[] }> {
  return { files: await collectAsync(sources, adapterCheck(adapterType)) }
}

/** listProviderCredentialFiles without blocking the event loop (daemon). */
export async function listProviderCredentialFilesAsync(providerId: string, sources: CredentialFileSources): Promise<{ files: ProviderCredentialFileInfo[] }> {
  return { files: await collectAsync(sources, providerCheck(providerId)) }
}
