import { describe, expect, it, vi } from 'vitest'
import { runMcpAuthPreflight, type McpAuthPreflightIO } from '../../../src/main/services/mcp-auth-preflight'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'

/**
 * Drives the preflight with real child processes (`node -e ...`) so spawn,
 * URL scraping, exit and timeout semantics are exercised end-to-end.
 * POSIX-oriented: the Windows cmd.exe quoting path is not exercised here.
 */

function serverCfg(script: string): McpServerConfig {
  return {
    name: 'auth_test',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', script],
  }
}

function makeIO(overrides: Partial<McpAuthPreflightIO> = {}): McpAuthPreflightIO & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    openUrl: (url: string) => { opened.push(url) },
    log: () => {},
    ...overrides,
  }
}

describe('runMcpAuthPreflight', () => {
  it('never opens a URL printed by an auth command that exits before the startup grace (error help text)', async () => {
    const io = makeIO({ startupGraceMs: 300 })
    await expect(runMcpAuthPreflight(
      serverCfg('console.error("OAuth credentials not found. Go to the Google Cloud Console (https://console.cloud.google.com/) to create them"); process.exit(1)'),
      {},
      io,
    )).rejects.toThrow(/exited with code 1.*credentials not found/s)
    expect(io.opened).toEqual([])
  })

  it('interactive: fails with stderr before showing the dialog when the auth command dies early', async () => {
    const confirm = vi.fn(async () => {})
    const io = makeIO({ confirm, startupGraceMs: 100 })
    await expect(runMcpAuthPreflight(
      serverCfg('console.error("Credentials file not found: /root/.config/x.json"); process.exit(1)'),
      {},
      io,
    )).rejects.toThrow(/exited with code 1 before authorization completed.*Credentials file not found/s)
    expect(confirm).not.toHaveBeenCalled()
    expect(io.opened).toEqual([])
  })

  it('interactive: skips the dialog when the auth command completes on its own', async () => {
    const confirm = vi.fn(async () => {})
    const io = makeIO({ confirm, startupGraceMs: 100 })
    await runMcpAuthPreflight(
      serverCfg('console.log("already authorized"); process.exit(0)'),
      {},
      io,
    )
    expect(confirm).not.toHaveBeenCalled()
  })

  it('interactive: fails after the dialog if the auth command died nonzero while it was up', async () => {
    // Child lives past the grace, then dies while "the dialog is open".
    const confirm = vi.fn(() => new Promise<void>((r) => setTimeout(r, 800)))
    const io = makeIO({ confirm, startupGraceMs: 100 })
    await expect(runMcpAuthPreflight(
      serverCfg('console.error("late failure"); setTimeout(() => process.exit(2), 400)'),
      {},
      io,
    )).rejects.toThrow(/exited with code 2 before authorization completed/)
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('headless: resolves on clean exit and opens the scraped URL with trailing punctuation stripped', async () => {
    // Child survives the startup grace (URL opens), then exits cleanly.
    const io = makeIO({ startupGraceMs: 100 })
    await runMcpAuthPreflight(
      serverCfg('console.log("Visit https://example.com/auth?x=1. to authorize"); setTimeout(() => process.exit(0), 400)'),
      {},
      io,
    )
    expect(io.opened).toEqual(['https://example.com/auth?x=1'])
  })

  it('headless: rejects with the exit code on nonzero exit', async () => {
    const io = makeIO()
    await expect(runMcpAuthPreflight(
      serverCfg('console.error("boom: token store unavailable"); process.exit(3)'),
      {},
      io,
    )).rejects.toThrow(/exited with code 3/)
  })

  it('headless: rejects on timeout, kills the child, and includes the scraped URL', async () => {
    const io = makeIO({ waitForExitTimeoutMs: 500, startupGraceMs: 100 })
    const start = Date.now()
    await expect(runMcpAuthPreflight(
      serverCfg('console.log("open https://example.com/slow-auth please"); setTimeout(() => {}, 10000)'),
      {},
      io,
    )).rejects.toThrow(/timed out.*https:\/\/example\.com\/slow-auth/s)
    // Killed at the timeout, not after the child's 10s sleep.
    expect(Date.now() - start).toBeLessThan(5000)
    expect(io.opened).toEqual(['https://example.com/slow-auth'])
  })

  it('headless: rejects plainly when the command cannot be spawned', async () => {
    const cfg: McpServerConfig = {
      name: 'auth_test',
      transport: 'stdio',
      command: '/nonexistent/definitely-not-a-binary',
      args: [],
    }
    await expect(runMcpAuthPreflight(cfg, {}, makeIO()))
      .rejects.toThrow(/failed to spawn/)
  })

  it('interactive: resolves once confirm resolves and kills the long-running child', async () => {
    const confirm = vi.fn(async (info: { serverName: string; authUrlOpened: boolean }) => {
      expect(info.serverName).toBe('auth_test')
      expect(info.authUrlOpened).toBe(true)
    })
    const io = makeIO({ confirm })
    const start = Date.now()
    // Child would run for 60s — interactive mode must not wait for exit.
    await runMcpAuthPreflight(
      serverCfg('console.log("https://example.com/interactive"); setTimeout(() => {}, 60000)'),
      {},
      io,
    )
    expect(confirm).toHaveBeenCalledOnce()
    expect(io.opened).toEqual(['https://example.com/interactive'])
    // 3s spawn grace + margin, but nowhere near the child's 60s lifetime.
    expect(Date.now() - start).toBeLessThan(20_000)
  }, 30_000)

  it('appends authArgs to the spawned command', async () => {
    const io = makeIO()
    // Child echoes its argv; authArgs must arrive as the trailing args.
    await runMcpAuthPreflight(
      serverCfg('console.log("args:" + process.argv.slice(1).join(","))'),
      { authArgs: ['auth', '--flag'] },
      io,
    )
    // Success (exit 0) is the assertion; argv content is verified via log below.
    const logs: string[] = []
    await runMcpAuthPreflight(
      serverCfg('console.log("args:" + process.argv.slice(1).join(","))'),
      { authArgs: ['auth', '--flag'] },
      { ...makeIO(), log: (m) => logs.push(m) },
    )
    expect(logs.some(l => l.includes('args:auth,--flag'))).toBe(true)
  })

  it('a pypi_package config with a resolved command runs exactly that command — the npx fallback never fires', async () => {
    // The Settings registration Connect test resolves the launch command
    // (`uv tool run <pkg> <userArgs>`) BEFORE the preflight and passes it as
    // command/args. With command set, neither the npx nor the uvBinPath
    // branch may rewrite the invocation — a registration-shaped config
    // without a command used to fall through to `npx <authArgs>`, executing
    // an unrelated npm package named after the auth arg.
    const logs: string[] = []
    const cfg: McpServerConfig = {
      name: 'pypi_auth',
      transport: 'stdio',
      pypi_package: 'mcp-foo',
      command: process.execPath,
      args: ['-e', 'console.log("args:" + process.argv.slice(1).join(","))', 'tool-run-marker'],
    }
    await runMcpAuthPreflight(cfg, { authArgs: ['auth'] }, { ...makeIO(), log: (m) => logs.push(m) })
    // Spawned the resolved command with user args kept and authArgs appended.
    expect(logs.some(l => l.includes(`Auth preflight: ${process.execPath}`))).toBe(true)
    expect(logs.some(l => l.includes('Auth preflight: npx'))).toBe(false)
    expect(logs.some(l => l.includes('args:tool-run-marker,auth'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Containerized preflight: loopback port detection, tunnel, container spawn
// ---------------------------------------------------------------------------

import { extractLoopbackPort, startLoopbackTunnel } from '../../../src/main/services/mcp-auth-preflight'
import { createServer as createNetServer, connect as netConnect, type AddressInfo } from 'net'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join as joinPath } from 'path'

describe('extractLoopbackPort', () => {
  it('finds an explicit localhost port in redirect_uri', () => {
    expect(extractLoopbackPort('https://accounts.example.com/auth?client_id=x&redirect_uri=' + encodeURIComponent('http://localhost:3000/callback'))).toBe(3000)
  })

  it('accepts 127.0.0.1 redirects', () => {
    expect(extractLoopbackPort('https://a.example.com/o?redirect_url=' + encodeURIComponent('http://127.0.0.1:8123/cb'))).toBe(8123)
  })

  it('returns null when no redirect param exists', () => {
    expect(extractLoopbackPort('https://example.com/device-code')).toBeNull()
  })

  it('returns null for non-localhost redirects', () => {
    expect(extractLoopbackPort('https://a.example.com/o?redirect_uri=' + encodeURIComponent('https://hosted.example.com:443/cb'))).toBeNull()
  })

  it('returns null for malformed URLs', () => {
    expect(extractLoopbackPort('not a url at all')).toBeNull()
  })

  it('returns null when the redirect has no explicit port', () => {
    expect(extractLoopbackPort('https://a.example.com/o?redirect_uri=' + encodeURIComponent('http://localhost/callback'))).toBeNull()
  })
})

const posixOnly = describe.skipIf(process.platform === 'win32')

/** Fake podman for the tunnel: drops `exec -i <name>` and execs the rest
 * (`node -e <bridge> <port>`) locally, so the bridge dials the "container"
 * loopback — which in the test is just the host loopback. */
function writeTunnelFakePodman(dir: string): string {
  const p = joinPath(dir, 'podman')
  writeFileSync(p, '#!/bin/sh\nshift 3\nexec "$@"\n')
  chmodSync(p, 0o755)
  return p
}

posixOnly('startLoopbackTunnel', () => {
  it('bridges host connections into the target port and releases the port on close', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'adf-tunnel-'))
    const fakePodman = writeTunnelFakePodman(dir)

    // Real TCP echo server plays the in-container callback listener.
    const echo = createNetServer((s) => { s.pipe(s) })
    await new Promise<void>((res) => echo.listen(0, '127.0.0.1', res))
    const echoPort = (echo.address() as AddressInfo).port

    const hostPort = 19473
    const tunnel = startLoopbackTunnel({ podmanBin: fakePodman, containerName: 'adf-mcp', hostPort, containerPort: echoPort })
    await tunnel.ready

    const roundTrip = await new Promise<string>((resolve, reject) => {
      const sock = netConnect(hostPort, '127.0.0.1', () => sock.write('ping-through-tunnel'))
      sock.on('data', (d) => { resolve(d.toString()); sock.destroy() })
      sock.on('error', reject)
      setTimeout(() => reject(new Error('tunnel round-trip timed out')), 5000)
    })
    expect(roundTrip).toBe('ping-through-tunnel')

    tunnel.close()
    // Port released: a fresh listener can bind it.
    await new Promise<void>((resolve, reject) => {
      const probe = createNetServer()
      probe.once('error', reject)
      probe.listen(hostPort, '127.0.0.1', () => probe.close(() => resolve()))
    })
    echo.close()
  }, 15_000)

  it('rejects ready plainly when the port is already in use', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'adf-tunnel-'))
    const fakePodman = writeTunnelFakePodman(dir)
    const holder = createNetServer()
    await new Promise<void>((res) => holder.listen(0, '127.0.0.1', res))
    const heldPort = (holder.address() as AddressInfo).port

    const tunnel = startLoopbackTunnel({ podmanBin: fakePodman, containerName: 'adf-mcp', hostPort: heldPort })
    await expect(tunnel.ready).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${heldPort}.*already using that port`))
    tunnel.close()
    holder.close()
  })

  it('survives the bridge closing mid-write (EPIPE on bridge.stdin must not crash)', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'adf-tunnel-'))
    const fakePodman = writeTunnelFakePodman(dir)

    // Target plays an OAuth callback listener: answer the first chunk, then
    // close — the bridge process exits while the host socket keeps writing,
    // which raises EPIPE on bridge.stdin. Without stream error handlers this
    // crashed the whole process.
    const target = createNetServer((s) => { s.once('data', () => { s.write('ok'); s.end() }) })
    await new Promise<void>((res) => target.listen(0, '127.0.0.1', res))
    const targetPort = (target.address() as AddressInfo).port

    const hostPort = 19474
    const tunnel = startLoopbackTunnel({ podmanBin: fakePodman, containerName: 'adf-mcp', hostPort, containerPort: targetPort })
    await tunnel.ready

    await new Promise<void>((resolve, reject) => {
      const sock = netConnect(hostPort, '127.0.0.1', () => sock.write('GET /callback'))
      sock.on('data', () => {
        // Bridge is now tearing down; keep writing into the dying pipe.
        const keepWriting = setInterval(() => { try { sock.write('trailing-bytes') } catch { /* socket gone */ } }, 20)
        const finish = () => { clearInterval(keepWriting); resolve() }
        sock.on('close', finish)
        sock.on('error', finish)
        setTimeout(finish, 2000)
      })
      sock.on('error', () => { /* expected once the bridge dies */ })
      setTimeout(() => reject(new Error('no response through tunnel')), 5000)
    })

    // Reaching here without an uncaughtException is the assertion; vitest
    // fails the run if the EPIPE escapes.
    tunnel.close()
    target.close()
  }, 15_000)
})

posixOnly('runMcpAuthPreflight container mode', () => {
  it('passes the crossing env via a 0600 --env-file (never on argv) and reaps it after the child exits', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'adf-container-preflight-'))
    const argvFile = joinPath(dir, 'argv.txt')
    const envCopyFile = joinPath(dir, 'envfile-copy.txt')
    const envModeFile = joinPath(dir, 'envfile-mode.txt')
    const fakePodman = joinPath(dir, 'podman')
    // The fake podman records its argv, then locates the --env-file value and
    // snapshots that file's contents + POSIX mode WHILE it still exists (podman
    // reads it at exec launch — the preflight reaps it only after this exits).
    writeFileSync(fakePodman, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${argvFile}"`,
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--env-file" ]; then',
      `    cp "$a" "${envCopyFile}"`,
      // GNU stat (-c %a = octal perms) first, BSD/macOS fallback (-f %Lp).
      // GNU-first matters: BSD `stat -c` errors and falls through, but GNU
      // `stat -f` means --file-system and would NOT error (wrong output).
      `    { stat -c '%a' "$a" 2>/dev/null || stat -f '%Lp' "$a"; } > "${envModeFile}"`,
      '    break',
      '  fi',
      '  prev="$a"',
      'done',
      // Auth URL with a loopback redirect so tunnel auto-detection also runs.
      'echo "Visit https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A18923%2Fcallback to authorize"',
      // Survive the startup grace so the URL is opened (a fast-exiting child
      // deliberately gets no browser tab), then exit cleanly.
      'sleep 0.4',
      'exit 0',
    ].join('\n'))
    chmodSync(fakePodman, 0o755)

    const cfg: McpServerConfig = {
      name: 'gdrive',
      transport: 'stdio',
      npm_package: '@example/gdrive-mcp',
      env: { SKEY: 'sval-secret' },
    }
    const io = makeIO({ startupGraceMs: 100 })
    await runMcpAuthPreflight(cfg, {
      authArgs: ['auth', '--flow'],
      resolvedEnv: { GKEY: 'gval-secret' },
      container: { podmanBin: fakePodman, containerName: 'adf-mcp', command: 'npx', args: ['-y', '@example/gdrive-mcp'], home: '/workspace/agent-1/home' },
    }, io)

    expect(existsSync(argvFile)).toBe(true)
    const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean)

    // Framing: exec -i --env-file <path> containerName command args authArgs
    expect(argv[0]).toBe('exec')
    expect(argv[1]).toBe('-i')
    expect(argv[2]).toBe('--env-file')
    const envFilePath = argv[3]
    const nameIdx = argv.indexOf('adf-mcp')
    expect(nameIdx).toBe(4)
    expect(argv.slice(nameIdx)).toEqual(['adf-mcp', 'npx', '-y', '@example/gdrive-mcp', 'auth', '--flow'])

    // No credential value may appear anywhere on argv, and no -e flag survives.
    expect(argv).not.toContain('-e')
    for (const secret of ['sval-secret', 'gval-secret']) {
      expect(argv.some(a => a.includes(secret))).toBe(false)
    }

    // The env-file itself is mode 0600 and carries the crossing env as KEY=VALUE
    // lines — agent HOME first (so an explicit serverCfg.env.HOME would win),
    // then the server env + resolvedEnv. No host process.env leak (no PATH).
    expect(readFileSync(envModeFile, 'utf8').trim()).toBe('600')
    const envLines = readFileSync(envCopyFile, 'utf8').split('\n').filter(Boolean)
    expect(envLines[0]).toBe('HOME=/workspace/agent-1/home')
    expect(envLines.slice(1).sort()).toEqual(['GKEY=gval-secret', 'SKEY=sval-secret'])
    expect(envLines.some(l => l.startsWith('PATH='))).toBe(false)
    expect(envLines.filter(l => l.startsWith('HOME=')).length).toBe(1)

    // The plaintext-credential env-file is unlinked once the child has exited.
    expect(existsSync(envFilePath)).toBe(false)

    // URL still scraped and opened in container mode.
    expect(io.opened).toEqual(['https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A18923%2Fcallback'])
  })
})
