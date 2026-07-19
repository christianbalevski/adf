import { execFile } from 'child_process'
import { promisify } from 'util'
import { getLanAddresses } from '../utils/network'

const execFileAsync = promisify(execFile)

/**
 * Inbound firewall rules that make this runtime reachable by LAN peers.
 *
 * Two rules, because LAN discovery uses two independent network paths and each
 * needs its own allowance:
 *   - TCP <mesh port> — peers fetch `/mesh/directory` over plain HTTP. Blocking
 *     this is the classic "peer sees my runtime row but 0 agents" failure: the
 *     mDNS multicast got through, the directory fetch didn't.
 *   - UDP 5353 — mDNS multicast itself. Usually already open (that's why the
 *     runtime is discoverable at all) but we assert it for completeness.
 *
 * Rules are named so the runtime check, the elevated apply, and the NSIS
 * installer all address the same records. Keep these strings in sync with
 * `build/installer.nsh`.
 */
export const FW_RULE_TCP = 'ADF Mesh (LAN)'
export const FW_RULE_UDP = 'ADF mDNS (LAN)'
export const MDNS_PORT = 5353

export interface LanFirewallState {
  platform: NodeJS.Platform
  /** True when the runtime can create/repair rules itself (with elevation). */
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

/** Encode a PowerShell script as a UTF-16LE base64 blob for `-EncodedCommand`. */
export function encodePwsh(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
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

/**
 * PowerShell that (re)creates the inbound Allow rules. Idempotent: removes any
 * prior rule of the same name — including a stale Block rule that would shadow
 * the Allow — before recreating. Program-scoped (`-Program`) so we open the
 * port only for this binary, not for every process. Requires elevation.
 */
export function buildWindowsApplyScript(port: number, exePath: string): string {
  const esc = (s: string): string => s.replace(/'/g, "''")
  const exe = esc(exePath)
  return [
    `$ErrorActionPreference = 'Stop'`,
    `foreach ($n in @('${FW_RULE_TCP}','${FW_RULE_UDP}')) {`,
    `  Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    `}`,
    `New-NetFirewallRule -DisplayName '${FW_RULE_TCP}' -Description 'ADF Studio mesh directory + inbox (LAN peers)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Program '${exe}' -Profile Private,Domain | Out-Null`,
    `New-NetFirewallRule -DisplayName '${FW_RULE_UDP}' -Description 'ADF Studio mDNS discovery' -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${MDNS_PORT} -Program '${exe}' -Profile Private,Domain | Out-Null`,
  ].join('\n')
}

/**
 * Wrap an inner (elevated) script in a non-elevated launcher that triggers the
 * UAC prompt via `Start-Process -Verb RunAs`, waits for it, and propagates its
 * exit code. A cancelled UAC prompt makes `Start-Process` throw — we map that
 * to ERROR_CANCELLED (1223) so the caller can report "declined" distinctly.
 */
export function buildWindowsElevatedLauncher(innerScript: string): string {
  const b64 = encodePwsh(innerScript)
  return [
    `try {`,
    `  $p = Start-Process powershell -Verb RunAs -PassThru -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${b64}'`,
    `  exit $p.ExitCode`,
    `} catch { exit 1223 }`,
  ].join('\n')
}

/** Probe the mesh server's LAN address to confirm it's up and LAN-bound. */
async function probeReachable(lanIp: string, port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await fetch(`http://${lanIp}:${port}/mesh/directory`, {
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
          : 'No inbound firewall rule — peers cannot fetch this runtime\'s agents.',
      }
    } catch (err) {
      return {
        platform,
        supported: true,
        ruleConfigured: null,
        reachable,
        lanIp,
        detail: `Could not query Windows Firewall: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  if (platform === 'darwin') {
    // The macOS application firewall is per-app and off by default. When it's
    // off, inbound is allowed and no rule is needed; when on, the app must be
    // added + unblocked. We can't reliably read per-app state without the exact
    // bundle path, so we surface capability and let apply handle it.
    return {
      platform,
      supported: true,
      ruleConfigured: null,
      reachable,
      lanIp,
      detail: 'macOS application firewall is per-app; use "Allow incoming" if it is enabled.',
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
    detail: 'Automatic firewall configuration is not available on this platform; open the mesh port manually.',
  }
}

/** Run a command, resolving to its stdout+exit code without throwing. */
async function tryExec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 })
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
 * without root, so it reports `ruleConfigured: null` (offer apply anyway;
 * `ufw allow` is idempotent).
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
        : 'firewalld is active but the mesh ports are closed — peers cannot fetch this runtime\'s agents.',
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
    }
  }

  // No manageable firewall active — inbound is open by default.
  return {
    ...base,
    supported: true,
    manager: null,
    ruleConfigured: true,
    detail: 'No active firewall detected — inbound LAN connections are open.',
  }
}

/** Build the elevated shell command that opens the ports for a Linux manager. */
export function buildLinuxApplyCommand(manager: 'firewalld' | 'ufw', port: number): string {
  if (manager === 'firewalld') {
    return `firewall-cmd --permanent --add-port=${port}/tcp --add-port=${MDNS_PORT}/udp && firewall-cmd --reload`
  }
  return `ufw allow ${port}/tcp && ufw allow ${MDNS_PORT}/udp`
}

export interface ApplyResult {
  success: boolean
  /** Present on failure. `'declined'` = user cancelled the elevation prompt. */
  error?: string
  declined?: boolean
}

/**
 * Create/repair the inbound Allow rules, prompting for elevation. On Windows a
 * single UAC prompt covers both rules; on macOS a single admin prompt covers
 * the app add + unblock. Returns `declined` when the user cancels the prompt.
 */
export async function applyLanFirewall(port: number): Promise<ApplyResult> {
  const platform = process.platform
  const exePath = process.execPath

  if (platform === 'win32') {
    const inner = buildWindowsApplyScript(port, exePath)
    const launcher = buildWindowsElevatedLauncher(inner)
    try {
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
        { timeout: 120_000, windowsHide: true }
      )
      return { success: true }
    } catch (err) {
      // execFileAsync rejects with `.code` = the process exit code.
      const code = (err as { code?: number }).code
      if (code === 1223) return { success: false, declined: true, error: 'Elevation was declined.' }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (platform === 'darwin') {
    const fw = '/usr/libexec/ApplicationFirewall/socketfilterfw'
    // Escape for embedding inside an AppleScript double-quoted shell string.
    const shExe = exePath.replace(/(["\\])/g, '\\$1')
    const shellCmd = `'${fw}' --add '${shExe}' && '${fw}' --unblockapp '${shExe}'`
    const appleScript = `do shell script "${shellCmd.replace(/(["\\])/g, '\\$1')}" with administrator privileges`
    try {
      await execFileAsync('osascript', ['-e', appleScript], { timeout: 120_000 })
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/User canceled|-128/.test(msg)) return { success: false, declined: true, error: 'Elevation was declined.' }
      return { success: false, error: msg }
    }
  }

  if (platform === 'linux') {
    // Re-detect the manager (state may have changed since the check) and apply
    // via pkexec, which raises the desktop's polkit password prompt. `ufw allow`
    // and `firewall-cmd --add-port` are both idempotent.
    const state = await checkLinuxFirewall(port, null, null)
    if (!state.manager) {
      return { success: false, error: 'No active firewall detected — nothing to configure.' }
    }
    const shellCmd = buildLinuxApplyCommand(state.manager, port)
    try {
      await execFileAsync('pkexec', ['sh', '-c', shellCmd], { timeout: 120_000 })
      return { success: true }
    } catch (err) {
      const code = (err as { code?: number }).code
      // pkexec: 126 = dismissed / not authorized, 127 = auth failed or missing.
      if (code === 126) return { success: false, declined: true, error: 'Authentication was declined.' }
      const enoent = (err as { code?: string }).code === 'ENOENT'
      if (enoent) {
        return { success: false, error: `pkexec not found. Run manually: sudo ${shellCmd}` }
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { success: false, error: 'Automatic firewall configuration is not supported on this platform.' }
}
