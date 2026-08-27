/**
 * File-shaped MCP credentials through the agent identity keystore.
 *
 * OAuth client keys and token stores live in `adf_identity` (credentials
 * envelope) under `mcp:<pkg|name>:file:<declared path>`, are MATERIALIZED
 * into the server's runtime filesystem before every spawn, and CAPTURED back
 * after a successful auth preflight. The runtime filesystem (container or
 * host) is a disposable projection; the keystore is the source of truth once
 * populated — the .adf carries the grants when the agent moves.
 *
 * Electron-free: usable from Studio, the daemon builder, and tests.
 * File content must never enter agent config, tool results, or exec argv —
 * container writes go through 0600 temp files + `podman cp`.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import type { McpServerConfig } from '../../shared/types/adf-v02.types'

/** Decoded size cap per credential file. Real targets are ~1 KB token files. */
export const CREDENTIAL_FILE_MAX_BYTES = 256 * 1024

/** JSON record stored as the identity value. */
interface CredentialFileRecord {
  encoding: 'base64'
  data: string
  /** POSIX file mode for materialization (default 0600). */
  mode?: number
  captured_at?: string
}

export interface CredentialContainerTarget {
  kind: 'container'
  containerName: string
  /** Agent-scoped HOME inside the container (containerAgentHome). */
  home: string
  copyToContainer: (hostPath: string, containerPath: string, containerName: string) => Promise<void>
  copyFromContainer: (containerPath: string, hostPath: string, containerName: string) => Promise<void>
  /** `test -f` inside the container — copyToContainer's exec layer never rejects, so writes are verified. */
  fileExists: (containerName: string, containerPath: string) => Promise<boolean>
}

export interface CredentialHostTarget {
  kind: 'host'
  /** Host home for ~ expansion. Defaults to os.homedir(). */
  home?: string
}

export type CredentialFileTarget = CredentialContainerTarget | CredentialHostTarget

/** Structural slice of PodmanService the credential plumbing needs. */
export interface CredentialCopyService {
  copyToContainer(hostPath: string, containerPath: string, containerName?: string): Promise<void>
  copyFromContainer(containerPath: string, hostPath: string, containerName?: string): Promise<void>
  containerFileExists(containerName: string, containerPath: string): Promise<boolean>
}

/** Build a container target from a PodmanService-shaped object. */
export function containerCredentialTarget(svc: CredentialCopyService, containerName: string, home: string): CredentialContainerTarget {
  return {
    kind: 'container',
    containerName,
    home,
    copyToContainer: (h, c, n) => svc.copyToContainer(h, c, n),
    copyFromContainer: (c, h, n) => svc.copyFromContainer(c, h, n),
    fileExists: (n, p) => svc.containerFileExists(n, p),
  }
}

export interface CredentialStore {
  /** Decrypt an identity value, or null when absent OR its envelope is locked. */
  getDecrypted: (purpose: string) => string | null
  /** Whether a row exists at all (distinguishes absent from locked-envelope). */
  hasRow: (purpose: string) => boolean
  /**
   * Runtime-specific recovery hint appended to the locked-envelope error
   * (e.g. the daemon names its public-key file and the trusted-keys setting).
   */
  envelopeLockedHint?: string
}

/**
 * Purposes for a declared credential file, in READ order: package namespace
 * first, then server-name namespace — mirroring resolveMcpEnvVars. Writes
 * always use the first (package) purpose.
 */
export function credentialFilePurposes(serverCfg: McpServerConfig, path: string): string[] {
  const pkgNs = serverCfg.npm_package ?? serverCfg.pypi_package ?? serverCfg.name
  const purposes = [`mcp:${pkgNs}:file:${path}`]
  if (serverCfg.name !== pkgNs) purposes.push(`mcp:${serverCfg.name}:file:${path}`)
  return purposes
}

/**
 * Expand a declared `~/...` path against the target's home.
 *
 * Host targets are CONFINED to the home directory: only `~`-relative paths
 * are accepted, and the resolved path must stay under home (rejects `..`
 * escapes). A host-routed server already runs its package code on the host,
 * but ADF itself must not be steerable into writing arbitrary host files
 * (e.g. ~/.zshenv is allowed by the trust model, /etc/cron.d is not — and a
 * narrow hostApproved grant should not imply arbitrary-path writes).
 * Container targets keep absolute paths — traversal is contained by the
 * container itself, and some servers hardcode absolute config paths.
 */
export function expandCredentialPath(path: string, target: CredentialFileTarget): string {
  const home = target.kind === 'container' ? target.home : (target.home ?? homedir())
  if (target.kind === 'host') {
    if (path !== '~' && !path.startsWith('~/')) {
      throw new Error(
        `Host credential files must live under ~ — declare a ~-relative path (got "${path}").`,
      )
    }
    const resolved = resolve(home, path === '~' ? '.' : path.slice(2))
    const homeResolved = resolve(home)
    if (resolved !== homeResolved && !resolved.startsWith(homeResolved + sep)) {
      throw new Error(
        `Host credential file path "${path}" escapes the home directory — declare a ~-relative path that stays under ~.`,
      )
    }
    return resolved
  }
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`
  return path
}

/**
 * Seal file content into the keystore. Throws on the size cap and (via
 * setIdentitySealed) when the credentials envelope is locked — a token file
 * must never be written unsealed.
 */
export function captureCredentialFile(
  store: {
    setIdentitySealed: (purpose: string, value: string) => void
    /**
     * Force the row's code_access flag. Optional so the minimal
     * `{ setIdentitySealed }` wrappers at existing call sites still satisfy the
     * type; when present it is called with `false` so a pre-seeded row cannot
     * leave a sealed credential file code-readable. The authoritative guarantee
     * for these purposes is AdfWorkspace.getIdentityForCode's reserved-purpose
     * backstop — this is defense in depth.
     */
    setIdentityCodeAccess?: (purpose: string, codeAccess: boolean) => void
  },
  serverCfg: McpServerConfig,
  path: string,
  content: Buffer,
  capturedAt: string,
): void {
  if (content.length > CREDENTIAL_FILE_MAX_BYTES) {
    throw new Error(
      `Credential file "${path}" for MCP server "${serverCfg.name}" is ${content.length} bytes — ` +
      `the keystore cap is ${CREDENTIAL_FILE_MAX_BYTES} bytes (${CREDENTIAL_FILE_MAX_BYTES / 1024} KiB).`,
    )
  }
  const record: CredentialFileRecord = {
    encoding: 'base64',
    data: content.toString('base64'),
    mode: 0o600,
    captured_at: capturedAt,
  }
  const purpose = credentialFilePurposes(serverCfg, path)[0]
  store.setIdentitySealed(purpose, JSON.stringify(record))
  store.setIdentityCodeAccess?.(purpose, false)
}

function decodeRecord(purpose: string, raw: string): { content: Buffer; mode: number } {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new Error(`Identity row "${purpose}" is not a credential-file record (expected JSON with base64 data).`)
  }
  const rec = parsed as CredentialFileRecord
  if (rec?.encoding !== 'base64' || typeof rec.data !== 'string') {
    throw new Error(`Identity row "${purpose}" is not a credential-file record (expected {encoding:"base64",data}).`)
  }
  return { content: Buffer.from(rec.data, 'base64'), mode: rec.mode ?? 0o600 }
}

const INGESTION_ROUTES =
  'Provide it via the `content` field of mcp_install credential_files, ' +
  'or fs_transfer it into the server\'s runtime filesystem.'

/**
 * Write every declared credential file the keystore holds into the server's
 * runtime filesystem. Keystore copies OVERWRITE runtime copies (the keystore
 * is the source of truth once populated). A missing `required` file fails
 * plainly; a missing optional file is left to the server to create (bootstrap
 * mode — e.g. tokens.json before first auth). A stored-but-locked row fails
 * plainly for BOTH required and optional files — only a truly absent row is
 * bootstrap state.
 */
export async function materializeCredentialFiles(
  store: CredentialStore,
  serverCfg: McpServerConfig,
  target: CredentialFileTarget,
): Promise<void> {
  const declared = serverCfg.credential_files ?? []
  for (const file of declared) {
    const purposes = credentialFilePurposes(serverCfg, file.path)
    const found = purposes.map((p) => ({ p, raw: store.getDecrypted(p) })).find((r) => r.raw != null)
    if (!found) {
      // getDecrypted() is null both for an absent row AND a locked envelope —
      // distinguish via hasRow BEFORE the optional short-circuit, so a locked
      // envelope fails plainly even for optional files (most OAuth token/cache
      // files are optional; silently materializing nothing would strand the
      // captured grant behind an opaque server-side auth error).
      const rowExists = purposes.some((p) => store.hasRow(p))
      // True bootstrap: nothing stored yet and the file is optional — the
      // server creates it (e.g. tokens.json before first auth).
      if (!rowExists && !file.required) continue
      // A file already present in the runtime FS (fs_transfer, pre-existing
      // install) is bootstrap state regardless of keystore state — the server
      // can use it and write-back captures it later.
      const existingPath = expandCredentialPath(file.path, target)
      const presentInRuntime = target.kind === 'host'
        ? existsSync(existingPath)
        : await target.fileExists(target.containerName, existingPath)
      if (presentInRuntime) continue
      // Present-but-locked (daemon without a runtime key): fail plainly for
      // optional and required files alike.
      if (rowExists) {
        throw new Error(
          `Credential file "${file.path}" for MCP server "${serverCfg.name}" exists in the keystore but the ` +
          'credentials envelope is locked in this runtime — open the agent in ADF Studio once, or provision a daemon runtime key.' +
          (store.envelopeLockedHint ? ` ${store.envelopeLockedHint}` : ''),
        )
      }
      // Only reachable for required files (optional + absent continued above).
      throw new Error(
        `Required credential file "${file.path}" for MCP server "${serverCfg.name}" is not in the identity keystore ` +
        `(looked for ${purposes.map((p) => `"${p}"`).join(' and ')}) and connect cannot proceed without it. ${INGESTION_ROUTES} ` +
        'Note: the declared path is part of the credential identity — if this declaration\'s path was CHANGED, ' +
        'any previously sealed copy still lives under the old path; re-declare the old path or re-supply the content at the new one ' +
        '(mcp_install with credential_files applies to an already-installed server).',
      )
    }
    const { content, mode } = decodeRecord(found.p, found.raw as string)
    const destPath = expandCredentialPath(file.path, target)
    if (target.kind === 'host') {
      mkdirSync(dirname(destPath), { recursive: true })
      writeFileSync(destPath, content, { mode })
    } else {
      // Through a 0600 temp file + podman cp — content never on an argv.
      const dir = mkdtempSync(join(tmpdir(), 'adf-cred-'))
      const tmp = join(dir, 'file')
      try {
        writeFileSync(tmp, content, { mode })
        await target.copyToContainer(tmp, destPath, target.containerName)
        // The podman exec layer resolves even when cp fails — verify.
        if (!(await target.fileExists(target.containerName, destPath))) {
          throw new Error(
            `Failed to materialize credential file "${file.path}" for MCP server "${serverCfg.name}" into ` +
            `container ${target.containerName} at ${destPath} — podman cp did not produce the file.`,
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}

/**
 * Read declared credential files (write_back !== false) back from the
 * server's runtime filesystem and capture them sealed. Files the flow did
 * not produce are skipped silently. Call ONLY after a successful auth
 * preflight — v1 does not chase refresh-token rotation during normal
 * operation (see the design doc).
 */
export async function writeBackCredentialFiles(
  store: { setIdentitySealed: (purpose: string, value: string) => void },
  serverCfg: McpServerConfig,
  target: CredentialFileTarget,
  capturedAt: string,
  log?: (msg: string) => void,
): Promise<void> {
  const declared = (serverCfg.credential_files ?? []).filter((f) => f.write_back !== false)
  for (const file of declared) {
    const srcPath = expandCredentialPath(file.path, target)
    // The source file was written by the (possibly hostile) server process:
    // stat BEFORE read so an oversized file fails plainly instead of being
    // materialized into memory (OOM) — the cap check in capture would be too late.
    const guardSize = (size: number): void => {
      if (size > CREDENTIAL_FILE_MAX_BYTES) {
        const msg =
          `Credential file "${file.path}" for MCP server "${serverCfg.name}" is ${size} bytes — ` +
          `the keystore cap is ${CREDENTIAL_FILE_MAX_BYTES} bytes (${CREDENTIAL_FILE_MAX_BYTES / 1024} KiB); write-back refused.`
        log?.(msg)
        throw new Error(msg)
      }
    }
    let content: Buffer | null = null
    if (target.kind === 'host') {
      if (existsSync(srcPath)) {
        guardSize(statSync(srcPath).size)
        content = readFileSync(srcPath)
      }
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'adf-cred-'))
      const tmp = join(dir, 'file')
      try {
        let copied = false
        try {
          await target.copyFromContainer(srcPath, tmp, target.containerName)
          copied = existsSync(tmp)
        } catch (err) {
          // podman cp also fails when the file does not exist ("not produced"),
          // but a transient copy failure right after a successful auth would
          // silently strand the grant in the container — always say why.
          log?.(
            `[MCP] Write-back skipped for "${file.path}" (${serverCfg.name}): could not copy from ` +
            `container ${target.containerName} — ${err instanceof Error ? err.message : String(err)}. ` +
            'If the auth flow did store this file, the grant lives only in the container until it is captured — re-run the auth preflight (reinstall with auth, or mcp_restart on an auth-declaring server) to write it back to the keystore.',
          )
        }
        if (copied) {
          guardSize(statSync(tmp).size)
          content = readFileSync(tmp)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    if (content == null) continue
    captureCredentialFile(store, serverCfg, file.path, content, capturedAt)
    log?.(`[MCP] Captured credential file "${file.path}" for "${serverCfg.name}" into the identity keystore`)
  }
}
