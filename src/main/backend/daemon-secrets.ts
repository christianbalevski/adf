import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { openKeychainBackend, type SecretBackend } from '../services/owner-secret-store'
import { testSeamsAllowed } from '../utils/test-seams'

/**
 * The secret store a local daemon on Studio's settings file reads, opened by
 * Studio main for the mode-switch handover (handover.ts): the runtime
 * identity entry and the app-level MCP sign-ins go there.
 *
 * The choice mirrors the daemon's own (daemon-identity.ts selectBackend);
 * Studio spawns the daemon with its own environment, so both see the same
 * variables. When the daemon would use its passphrase file, Studio cannot
 * write for it (it has no passphrase): null, with the reason, and the switch
 * dialog states the §5.3.1 fallback.
 */

/** Same variable as daemon-identity.ts TEST_KEYCHAIN_FILE_ENV (test seam). */
export const TEST_KEYCHAIN_FILE_ENV = 'ADF_TEST_KEYCHAIN_FILE'

/**
 * The test keychain file (`{ "<account>": "<value>" }`), the format the
 * daemon's TestKeychainFileBackend reads. Test seam only.
 */
class JsonFileKeychain implements SecretBackend {
  readonly kind = 'keychain' as const
  constructor(private readonly filePath: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.filePath)) return {}
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
  }

  private write(values: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.studio.tmp`
    writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.filePath)
  }

  isUnlocked(): boolean { return true }
  get(account: string): string | null { return this.read()[account] ?? null }
  set(account: string, value: string): void { this.write({ ...this.read(), [account]: value }) }
  delete(account: string): void {
    const values = this.read()
    if (!(account in values)) return
    delete values[account]
    this.write(values)
  }
}

export interface DaemonSecretsChoice {
  backend: SecretBackend | null
  /** Why `backend` is null, as the switch dialog states it. */
  unavailable?: string
}

export function openDaemonSecrets(env: NodeJS.ProcessEnv = process.env, opts: { packaged?: boolean } = {}): DaemonSecretsChoice {
  if (env.ADF_SECRET_STORE === 'file') {
    return { backend: null, unavailable: 'the daemon keeps its secrets in its passphrase file (ADF_SECRET_STORE=file), which Studio cannot write' }
  }
  if (env.ADF_KEYCHAIN === '0' || env.ADF_KEYCHAIN === 'off') {
    return { backend: null, unavailable: 'the OS keychain is turned off (ADF_KEYCHAIN=0)' }
  }
  const fake = env[TEST_KEYCHAIN_FILE_ENV]
  if (fake) {
    if (!opts.packaged && testSeamsAllowed({ env })) return { backend: new JsonFileKeychain(fake) }
    // Fail closed, as the daemon does: never fall through to the real keychain.
    return { backend: null, unavailable: `${TEST_KEYCHAIN_FILE_ENV} is set without the test seams` }
  }
  const keychain = openKeychainBackend()
  return keychain ? { backend: keychain } : { backend: null, unavailable: 'no OS keychain is usable on this machine' }
}
