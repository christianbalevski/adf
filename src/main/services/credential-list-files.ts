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
 */

import { readdirSync } from 'fs'
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

/** Visit each known file, then each .adf in the tracked directories (depth 0..3), once each. */
function forEachAgentFile(sources: CredentialFileSources, visit: (filePath: string) => void): void {
  const seen = new Set<string>()
  const checkFile = (filePath: string): void => {
    if (seen.has(filePath)) return
    seen.add(filePath)
    try {
      visit(filePath)
    } catch {
      // Skip files that can't be read
    }
  }

  for (const filePath of sources.knownFiles) checkFile(filePath)

  for (const dir of sources.trackedDirs) {
    try {
      const scanFiles = (dirPath: string, depth: number) => {
        if (depth > 3) return
        const entries = readdirSync(dirPath, { withFileTypes: true })
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.adf')) {
            checkFile(join(dirPath, e.name))
          } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
            scanFiles(join(dirPath, e.name), depth + 1)
          }
        }
      }
      scanFiles(dir, 0)
    } catch {
      // Skip dirs that can't be read
    }
  }
}

/** Files holding `mcp:<npmPackage>:*` credentials or naming the server in their config. */
export function listMcpCredentialFiles(
  args: { mcpServerName: string; npmPackage: string },
  sources: CredentialFileSources,
): { files: CredentialFileInfo[] } {
  const prefix = `mcp:${args.npmPackage}:`
  const results: CredentialFileInfo[] = []
  forEachAgentFile(sources, (filePath) => {
    const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
    const populatedKeys = purposes.map((p) => p.slice(prefix.length))

    // Include if file has stored credentials for this server
    if (populatedKeys.length > 0) {
      results.push({ filePath, fileName: basename(filePath), hasCredentials: true, populatedKeys })
      return
    }

    // Also include if the file references this MCP server in its config (even without creds yet)
    const mcpNames = AdfDatabase.peekMcpServerNames(filePath)
    if (mcpNames.includes(args.mcpServerName)) {
      results.push({ filePath, fileName: basename(filePath), hasCredentials: false, populatedKeys: [] })
    }
  })
  return { files: results }
}

/** Files holding `adapter:<type>:*` credentials or configuring the adapter. */
export function listAdapterCredentialFiles(adapterType: string, sources: CredentialFileSources): { files: CredentialFileInfo[] } {
  const prefix = `adapter:${adapterType}:`
  const results: CredentialFileInfo[] = []
  forEachAgentFile(sources, (filePath) => {
    const purposes = AdfDatabase.peekIdentityPurposes(filePath, prefix)
    const populatedKeys = purposes.map((p) => p.slice(prefix.length))

    // Include if file has stored credentials for this adapter
    if (populatedKeys.length > 0) {
      results.push({ filePath, fileName: basename(filePath), hasCredentials: true, populatedKeys })
      return
    }

    // Also include if the file references this adapter type in its config
    const adapterTypes = AdfDatabase.peekAdapterTypes(filePath)
    if (adapterTypes.includes(adapterType)) {
      results.push({ filePath, fileName: basename(filePath), hasCredentials: false, populatedKeys: [] })
    }
  })
  return { files: results }
}

/** Files holding `provider:<id>:*` credentials or a copy of the provider in their config. */
export function listProviderCredentialFiles(providerId: string, sources: CredentialFileSources): { files: ProviderCredentialFileInfo[] } {
  const prefix = `provider:${providerId}:`
  const results: ProviderCredentialFileInfo[] = []
  forEachAgentFile(sources, (filePath) => {
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
      results.push({ filePath, fileName: basename(filePath), hasCredentials: true, populatedKeys, providerConfig })
      return
    }

    // Also include if the file references this provider in its config
    if (copy) {
      results.push({ filePath, fileName: basename(filePath), hasCredentials: false, populatedKeys: [], providerConfig })
    }
  })
  return { files: results }
}
