#!/usr/bin/env node
/**
 * macOS dev only: sign node_modules' Electron.app with a fixed self-signed
 * certificate, so the login keychain recognises it as the same app across
 * Electron updates and reinstalls.
 *
 * Why: the downloaded Electron is ad-hoc signed, and macOS keys an ad-hoc
 * app's keychain trust to the exact binary. Every new Electron then reads as
 * a new app, and each "ADF" keychain item asks for the password again even
 * after "Always Allow". Signed with one certificate, the trust survives:
 * each item asks once, ever.
 *
 * The certificate ("ADF Dev Code Signing") is created on first run in the
 * login keychain, readable by codesign only. It signs nothing that ships:
 * packaged builds are signed by electron-builder.
 *
 * Runs after install-electron (postinstall). Never fails the install:
 * anything that goes wrong is a warning, and the ad-hoc Electron still runs.
 * Skipped off macOS, in CI, and with ADF_SKIP_DEV_SIGN=1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IDENTITY = 'ADF Dev Code Signing'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db')

const log = (line) => console.log(`[sign-dev-electron] ${line}`)
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

/** SHA-1 of the identity's certificate, or null when the keychain has none. */
function findIdentity() {
  // Without -v: a self-signed certificate is not trusted, and codesign uses it all the same.
  const out = run('security', ['find-identity', '-p', 'codesigning', keychain])
  const line = out.split('\n').find((l) => l.includes(`"${IDENTITY}"`))
  return line?.match(/\b([0-9A-F]{40})\b/)?.[1] ?? null
}

function createIdentity() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-dev-sign-'))
  try {
    const conf = join(dir, 'cert.conf')
    writeFileSync(conf, [
      '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
      '[dn]', `CN = ${IDENTITY}`,
      '[ext]', 'basicConstraints = critical, CA:false', 'keyUsage = critical, digitalSignature', 'extendedKeyUsage = critical, codeSigning',
    ].join('\n'))
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    const p12 = join(dir, 'identity.p12')
    const pass = randomBytes(16).toString('hex')
    run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-config', conf, '-keyout', key, '-out', cert])
    run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', `pass:${pass}`])
    // -T: codesign may use the key without asking.
    run('security', ['import', p12, '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  log(`created the "${IDENTITY}" certificate in the login keychain`)
}

function signedWith(hash) {
  try {
    // The designated requirement names the certificate's leaf hash when signed with it.
    return run('codesign', ['-d', '-r-', app]).toUpperCase().includes(hash) || false
  } catch {
    return false
  }
}

function main() {
  if (process.platform !== 'darwin' || process.env.CI || process.env.ADF_SKIP_DEV_SIGN === '1') return
  if (!existsSync(app)) {
    log(`no ${app}; skipped`)
    return
  }
  let hash = findIdentity()
  if (!hash) {
    createIdentity()
    hash = findIdentity()
    if (!hash) throw new Error(`"${IDENTITY}" was imported but codesign cannot find it`)
  }
  if (signedWith(hash)) return
  run('codesign', ['--force', '--deep', '--sign', hash, app])
  log(`signed Electron.app with "${IDENTITY}": keychain access survives Electron updates (each item asks once)`)
}

try {
  main()
} catch (err) {
  const detail = err?.stderr?.toString().trim() || err?.message || String(err)
  log(`skipped: ${detail}. Electron stays ad-hoc signed, so the keychain asks again after each Electron update. ADF_SKIP_DEV_SIGN=1 silences this.`)
}
