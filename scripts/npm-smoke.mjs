#!/usr/bin/env node
/* global console, process, fetch, setTimeout */
// Smoke test for an installed `@agentdocumentformat/cli` package: the `adf` on
// PATH prints its version, boots a daemon on a spare port with throwaway
// settings/data (never the user's), and answers `adf agents`. Then, with no
// daemon running, `adf agents` must start one in the background by itself
// (and `adf daemon status` must see it).
// Used by the release workflow after `npm i -g <tarball>`; runnable locally
// the same way (`node scripts/npm-smoke.mjs`), ideally with an isolated
// npm_config_prefix on PATH.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.SMOKE_PORT ?? 7399)
const URL = `http://127.0.0.1:${PORT}`
const WIN = process.platform === 'win32'
const data = mkdtempSync(join(tmpdir(), 'adf-npm-smoke-'))
writeFileSync(join(data, 'adf-settings.json'), '{}\n')

const env = {
  ...process.env,
  ADF_DAEMON_PORT: String(PORT),
  // The auto-start check below must never reach for the user's daemon.
  ADF_DAEMON_URL: URL,
  ADF_DAEMON_SETTINGS: join(data, 'adf-settings.json'),
  ADF_USER_DATA_DIR: data,
  ADF_TEMP_DIR: data,
  MESH_PORT: String(PORT + 1),
}

function adf(args) {
  // adf is a .cmd shim on Windows, which needs a shell.
  return execFileSync(WIN ? 'adf.cmd' : 'adf', args, { env, encoding: 'utf-8', timeout: 60_000, shell: WIN })
}

function fail(message, log = '') {
  console.error(`npm smoke FAILED: ${message}`)
  if (log) console.error(`--- daemon output ---\n${log}`)
  process.exitCode = 1
}

const version = adf(['--version']).trim()
console.log(`adf --version: ${version}`)
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`unexpected version output "${version}"`)
if (!adf(['--help']).includes('daemon [--port')) fail('--help lacks the daemon command')

const started = Date.now()
const daemon = spawn(WIN ? 'adf.cmd' : 'adf', ['daemon'], { env, shell: WIN, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
daemon.stdout.on('data', (d) => { log += d })
daemon.stderr.on('data', (d) => { log += d })
let up = false
for (let i = 0; i < 150 && !up && daemon.exitCode === null; i++) {
  await new Promise((r) => setTimeout(r, 200))
  try { up = (await fetch(`${URL}/health`)).ok } catch { /* not listening yet */ }
}
try {
  if (!up) {
    fail(`daemon did not answer ${URL}/health within 30s`, log)
  } else {
    console.log(`daemon healthy after ${Date.now() - started} ms`)
    const agents = adf(['--url', URL, 'agents'])
    console.log(`adf agents: ${agents.trim()}`)
    // Access token: minted next to the settings, printed by `adf daemon token`,
    // required on everything but /health; browser origins are refused.
    const tokenFile = join(data, 'daemon-token')
    const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf-8').trim() : ''
    if (!token) fail(`no daemon token at ${tokenFile}`, log)
    const printed = execFileSync(WIN ? 'adf.cmd' : 'adf', ['daemon', 'token', '--port', String(PORT)], { env, encoding: 'utf-8', timeout: 60_000, shell: WIN, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (printed !== token) fail('adf daemon token does not print the daemon\'s token')
    const noToken = await fetch(`${URL}/openapi.json`)
    if (noToken.status !== 401) fail(`/openapi.json without a token -> ${noToken.status} (want 401)`, log)
    const foreign = await fetch(`${URL}/agents`, { headers: { Authorization: `Bearer ${token}`, Origin: 'http://evil.example' } })
    if (foreign.status !== 403) fail(`foreign Origin -> ${foreign.status} (want 403)`, log)
    const spec = await fetch(`${URL}/openapi.json`, { headers: { Authorization: `Bearer ${token}` } })
    if (!spec.ok) fail(`/openapi.json -> ${spec.status}`, log)
    console.log('token + cross-origin checks OK')
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(log)) fail('daemon logged a missing module', log)
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err), log)
} finally {
  try {
    if (WIN) execFileSync('taskkill', ['/PID', String(daemon.pid), '/T', '/F'], { stdio: 'ignore' })
    // Graceful stop on CI; elsewhere SIGKILL, because a graceful stop also
    // stops ADF's compute containers, which a real daemon may be using.
    else process.kill(-daemon.pid, process.env.CI ? 'SIGTERM' : 'SIGKILL')
  } catch { /* already gone */ }
  // Wait for the first daemon to exit before the auto-start phase: a graceful
  // stop can take several seconds (compute shutdown probes podman), and an
  // exiting daemon's pid file must not be mistaken for a starting one.
  if (daemon.exitCode === null && daemon.signalCode === null) {
    await Promise.race([
      new Promise((r) => daemon.once('exit', r)),
      new Promise((r) => setTimeout(r, 30_000)),
    ])
  }
}

// Auto-start: nothing listens now; `adf agents` starts the daemon in the background.
async function healthy() {
  try { return (await fetch(`${URL}/health`)).ok } catch { return false }
}
if (!process.exitCode) {
  let autoPid = null
  try {
    if (await healthy()) throw new Error('the first daemon is still running')
    const t0 = Date.now()
    const out = execFileSync(WIN ? 'adf.cmd' : 'adf', ['agents'], { env, encoding: 'utf-8', timeout: 120_000, shell: WIN, stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(`adf agents (auto-start, ${Date.now() - t0} ms): ${out.trim()}`)
    if (!await healthy()) throw new Error('adf agents did not leave a daemon running')
    const status = adf(['daemon', 'status', '--port', String(PORT)])
    console.log(status.trim())
    if (!/status\s+running/.test(status)) throw new Error('adf daemon status does not see the auto-started daemon')
    const pidFile = join(data, `adf-daemon-${PORT}.pid`)
    autoPid = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf-8')).pid : null
    if (!autoPid) throw new Error(`no pid file at ${pidFile}`)
    if (process.env.CI) {
      // Graceful stop (also stops ADF's compute containers: CI only).
      console.log(adf(['daemon', 'stop', '--port', String(PORT)]).trim())
      if (await healthy()) throw new Error('adf daemon stop left the daemon running')
      autoPid = null
    }
    console.log('auto-start OK')
  } catch (err) {
    const logFile = join(data, 'logs', `adf-daemon-${PORT}.log`)
    fail(`auto-start: ${err instanceof Error ? err.message : String(err)}`, existsSync(logFile) ? readFileSync(logFile, 'utf-8').slice(-4000) : '')
  } finally {
    if (autoPid) {
      try {
        if (WIN) execFileSync('taskkill', ['/PID', String(autoPid), '/T', '/F'], { stdio: 'ignore' })
        else process.kill(autoPid, 'SIGKILL')
      } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
try { rmSync(data, { recursive: true, force: true }) } catch { /* locked on Windows; temp dir */ }
if (!process.exitCode) console.log('npm smoke OK')
