/**
 * Built-in Google OAuth client for the Gmail catalog server (see
 * shared/utils/gmail-oauth-client.ts). When the build embedded one and the
 * host has no client file yet, the registration test and host materialization
 * write it to ~/.gmail-mcp/gcp-oauth.keys.json (0600, write-if-absent). A
 * client file the user chose, or one already on the host, always wins; the
 * token file (~/.gmail-mcp/credentials.json) is never touched.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH } from '../../shared/utils/gmail-oauth-client'

// Defined by electron.vite.config.ts in the Studio main and daemon builds
// (undefined when the build had no client). Builds that do not define it at
// all (npm CLI, tests) read it as undefined via typeof.
declare const __ADF_GMAIL_OAUTH_CLIENT__: string | undefined

/** The client JSON compiled into this build, if any. */
export function compiledGmailOAuthClient(): string | undefined {
  return typeof __ADF_GMAIL_OAUTH_CLIENT__ === 'string' ? __ADF_GMAIL_OAUTH_CLIENT__ : undefined
}

/** Declared credential files this build can fill itself (MCP_REGISTRY_GET's `bundledCredentialFiles`). */
export function bundledCredentialFiles(client = compiledGmailOAuthClient()): { npmPackage: string; path: string }[] {
  return client ? [{ npmPackage: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, path: GMAIL_BUNDLED_CLIENT_PATH }] : []
}

/**
 * Whether the built-in client applies to this server and declared file:
 * exactly the Gmail catalog package and its client-file path.
 */
export function bundledClientApplies(npmPackage: string | undefined, path: string, client = compiledGmailOAuthClient()): boolean {
  return !!client && npmPackage === GMAIL_BUNDLED_CLIENT_NPM_PACKAGE && path === GMAIL_BUNDLED_CLIENT_PATH
}

/**
 * Write the built-in client to `dest` (the host expansion of `path`) if it
 * applies and the file is absent. Returns whether it wrote.
 */
export function writeBundledClientIfAbsent(
  npmPackage: string | undefined,
  path: string,
  dest: string,
  client = compiledGmailOAuthClient(),
): boolean {
  if (!client || !bundledClientApplies(npmPackage, path, client)) return false
  if (existsSync(dest)) return false
  mkdirSync(dirname(dest), { recursive: true })
  // 'wx': never replace a file that appeared since the check.
  try {
    writeFileSync(dest, client, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  return true
}
