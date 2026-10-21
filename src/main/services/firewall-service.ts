import { execFile } from 'child_process'
import { promisify } from 'util'
import { getLanAddresses } from '../utils/network'

const execFileAsync = promisify(execFile)

/**
 * Inbound firewall rules that make this runtime reachable by LAN peers.
 * Read-only: Studio never adds a rule itself (docs/design/remote-access.md
 * R9). The check says what blocks and gives the exact commands to run by
 * hand (`commands`); the user runs them in an elevated shell.
 *
 * Two rules, because LAN discovery uses two independent network paths and each
 * needs its own allowance:
 *   - TCP <mesh port> — peers fetch `/agents` over plain HTTP. Blocking
 *     this is the classic "peer sees my runtime row but 0 agents" failure: the
 *     mDNS multicast got through, the directory fetch didn't.
 *   - UDP 5353 — mDNS multicast itself. Usually already open (that's why the
 *     runtime is discoverable at all) but we assert it for completeness.
 *
 * Rules are named so the runtime check, the commands shown, and the NSIS
 * installer all address the same records. Keep these strings in sync with
 * `build/installer.nsh`.
 */
export const FW_RULE_TCP = 'ADF Mesh (LAN)'
export const FW_RULE_UDP = 'ADF mDNS (LAN)'
export const MDNS_PORT = 5353

export interface LanFirewallState {
  platform: NodeJS.Platform
  /** True when the rule state can be read on this platform. */
  supported: boolean
  /**
   * Whether an inbound Allow rule for this runtime is present + enabled.
   * `null` when unknown (unsupported platform, or the query itself failed).
   */
  ruleConfigured: boolean | null
  /**
   * Self-probe: is the mesh server answering on the LAN address? Confirms the
   * server is up and bound to `0.0.0.0`. NOTE: on Windows a same-host connect
   * to your own LAN IP commonly bypasses the inbound firewall, so this proves
   * "server is LAN-bound", NOT "peers can reach me" — `ruleConfigured` is the
   * signal for the firewall path.
   */
  reachable: boolean | null
  lanIp: string | null
  detail: string
  /** Active Linux firewall manager, when one was detected. */
  manager?: 'firewalld' | 'ufw' | null
  /** The exact commands that add the rules, for an elevated shell (R9: shown, never run). Empty when none is needed. */
  commands: string[]
}

/** Pick the first RFC1918 IPv4 address — the one a LAN peer would reach us on. */
export function firstLanIpv4(): string | null {
  const isRfc1918 = (ip: string): boolean =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  for (const a of getLanAddresses().addresses) {
    if (a.family === 'IPv4' && isRfc1918(a.address)) return a.address
  }
  return null
}

/**
 * PowerShell that reports (as compact JSON) whether our inbound Allow rule
 * exists and is enabled. Read-only — runs WITHOUT elevation.
 */
export function buildWindowsCheckScript(): string {
  return [
    `$r = Get-NetFirewallRule -DisplayName '${FW_RULE_TCP}' -ErrorAction SilentlyContinue`,
    `$ok = $false`,
    `if ($r) { $ok = @($r | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }).Count -gt 0 }`,
    `[Console]::Out.Write((@{ ruleConfigured = [bool]$ok } | ConvertTo-Json -Compress))`,
  ].join('; ')
}

/** Quote a path for PowerShell: single quotes, a quote doubled. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** Quote a path for a POSIX shell. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * The commands that add the inbound Allow rules, shown for the user to run
 * in an elevated shell (R9: Studio never runs them). Windows: program-scoped
 * rules on the Private and Domain profiles, never Public. macOS: the
 * application firewall's allow for this binary. Linux: the active manager's
 * ports; none when no firewall is active.
 */
export function lanFirewallCommands(platform: NodeJS.Platform, port: number, exePath: string, manager?: 'firewalld' | 'ufw' | null): string[] {
  if (platform === 'win32') {
    const exe = psQuote(exePath)
    // Any rule of that name goes first: a stale one (a Block rule) would still win, and a re-run adds no duplicate.
    const replace = (name: string) => `Get-NetFirewallRule -DisplayName ${psQuote(name)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName ${psQuote(name)}`
    return [
      `${replace(FW_RULE_TCP)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Program ${exe} -Profile Private,Domain`,
      `${replace(FW_RULE_UDP)} -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${MDNS_PORT} -Program ${exe} -Profile Private,Domain`,
    ]
  }
  if (platform === 'darwin') {
    const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw'
    return [`sudo ${fw} --add ${shQuote(exePath)}`, `sudo ${fw} --unblockapp ${shQuote(exePath)}`]
  }
  if (platform === 'linux' && manager) return buildLinuxApplyCommand(manager, port).split(' && ').map((c) => `sudo ${c}`)
  return []
}

/** Probe the mesh server's LAN address to confirm it's up and LAN-bound. */
async function probeReachable(lanIp: string, port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await fetch(`http://${lanIp}:${port}/agents`, {
        signal: ctrl.signal,
      })
      return res.ok
    } finally {
      clearTimeout(t)
    }
  } catch {
    return false
  }
}

/**
 * Inspect the LAN-reachability preconditions for this runtime: firewall rule
 * state (read-only, no elevation) plus a self-probe. Never throws — a failed
 * query degrades to `null`/`false` with an explanatory `detail`.
 */
export async function checkLanFirewall(port: number): Promise<LanFirewallState> {
  const platform = process.platform
  const lanIp = firstLanIpv4()
  const reachable = lanIp ? await probeReachable(lanIp, port) : null

  if (platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', buildWindowsCheckScript()],
        { timeout: 15_000, windowsHide: true }
      )
      const parsed = JSON.parse(stdout.trim() || '{}') as { ruleConfigured?: boolean }
      const ruleConfigured = !!parsed.ruleConfigured
      return {
        platform,
        supported: true,
        ruleConfigured,
        reachable,
        lanIp,
        detail: ruleConfigured
          ? 'Inbound firewall rule present.'
          : 'No inbound firewall rule: peers cannot fetch this runtime\'s agents.',
        commands: ruleConfigured ? [] : lanFirewallCommands(platform, port, process.execPath),
      }
    } catch (err) {
      return {
        platform,
        supported: true,
        ruleConfigured: null,
        reachable,
        lanIp,
        detail: `Could not query Windows Firewall: ${err instanceof Error ? err.message : String(err)}`,
        commands: lanFirewallCommands(platform, port, process.execPath),
      }
    }
  }

  if (platform === 'darwin') {
    // The macOS application firewall is per-app and off by default. When it's
    // off, inbound is allowed and no rule is needed; when on, the app must be
    // added + unblocked. We can't reliably read per-app state without the exact
    // bundle path, so we show the commands for when it is on.
    return {
      platform,
      supported: true,
      ruleConfigured: null,
      reachable,
      lanIp,
      detail: 'The macOS application firewall is per app. If it is on, allow incoming connections for ADF Studio.',
      commands: lanFirewallCommands(platform, port, process.execPath),
    }
  }

  if (platform === 'linux') {
    return checkLinuxFirewall(port, reachable, lanIp)
  }

  return {
    platform,
    supported: false,
    ruleConfigured: null,
    reachable,
    lanIp,
    detail: `Open TCP port ${port} and UDP port ${MDNS_PORT} for ADF Studio in this computer's firewall.`,
    commands: [],
  }
}

/** Run a command, resolving to its stdout+exit code without throwing. */
async function tryExec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, windowsHide: true })
    return { code: 0, stdout: stdout.toString() }
  } catch (err) {
    const code = typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 1
    const stdout = (err as { stdout?: Buffer | string }).stdout?.toString() ?? ''
    return { code, stdout }
  }
}

/**
 * Detect the active Linux firewall manager and (for firewalld) whether our
 * ports are already open. Read-only — `firewall-cmd --state`/`--query-port` and
 * `systemctl is-active` all work without root. ufw rule state can't be read
 * without root, so it reports `ruleConfigured: null` (the commands are shown
 * anyway; `ufw allow` is idempotent).
 */
async function checkLinuxFirewall(
  port: number,
  reachable: boolean | null,
  lanIp: string | null
): Promise<LanFirewallState> {
  const base = { platform: 'linux' as NodeJS.Platform, reachable, lanIp }

  // firewalld: state + per-port query are both non-root readable.
  const fwState = await tryExec('firewall-cmd', ['--state'])
  if (fwState.code === 0 && /running/i.test(fwState.stdout)) {
    const tcp = await tryExec('firewall-cmd', [`--query-port=${port}/tcp`])
    const udp = await tryExec('firewall-cmd', [`--query-port=${MDNS_PORT}/udp`])
    const ruleConfigured = tcp.code === 0 && udp.code === 0
    return {
      ...base,
      supported: true,
      manager: 'firewalld',
      ruleConfigured,
      detail: ruleConfigured
        ? 'firewalld is active and the ports are open.'
        : 'firewalld is active but the mesh ports are closed: peers cannot fetch this runtime\'s agents.',
      commands: ruleConfigured ? [] : lanFirewallCommands('linux', port, '', 'firewalld'),
    }
  }

  // ufw: detect active via systemctl (non-root); rule state needs root, so null.
  const ufwActive = await tryExec('systemctl', ['is-active', 'ufw'])
  if (ufwActive.code === 0 && /^active/.test(ufwActive.stdout.trim())) {
    return {
      ...base,
      supported: true,
      manager: 'ufw',
      ruleConfigured: null,
      detail: 'ufw is active. Allow the mesh ports so peers can fetch this runtime\'s agents.',
      commands: lanFirewallCommands('linux', port, '', 'ufw'),
    }
  }

  // No manageable firewall active — inbound is open by default.
  return {
    ...base,
    supported: true,
    manager: null,
    ruleConfigured: true,
    detail: 'No active firewall detected: inbound LAN connections are open.',
    commands: [],
  }
}

/** The shell command that opens the ports for a Linux manager (run as root, by the user). */
export function buildLinuxApplyCommand(manager: 'firewalld' | 'ufw', port: number): string {
  if (manager === 'firewalld') {
    return `firewall-cmd --permanent --add-port=${port}/tcp --add-port=${MDNS_PORT}/udp && firewall-cmd --reload`
  }
  return `ufw allow ${port}/tcp && ufw allow ${MDNS_PORT}/udp`
}
