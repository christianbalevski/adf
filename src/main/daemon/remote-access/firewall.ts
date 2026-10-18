/**
 * Firewall state, read without elevation (docs/design/remote-access.md §6).
 * ADF never adds a rule: Windows and macOS ask the user themselves the
 * first time the daemon listens on a network address. This only says when
 * a block can be seen, and how to lift it.
 */

import type { RemoteAccessStatus } from '../../../shared/types/remote-access.types'
import { defaultExec, type Exec } from './network-category'

export type FirewallView = RemoteAccessStatus['firewall']

export function linuxFirewallCommands(port: number): string[] {
  return [
    `sudo ufw allow from 192.168.0.0/16 to any port ${port} proto tcp`,
    `sudo firewall-cmd --zone=home --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`,
  ]
}

/** PowerShell: the number of enabled inbound Block rules for `program`. */
export function windowsBlockQuery(program: string): string {
  const quoted = program.replace(/'/g, "''")
  return `@(Get-NetFirewallApplicationFilter -Program '${quoted}' -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }).Count`
}

export interface FirewallProbeInput {
  port: number
  platform?: NodeJS.Platform
  program?: string
  exec?: Exec
}

export async function probeFirewall(input: FirewallProbeInput): Promise<FirewallView> {
  const platform = input.platform ?? process.platform
  const exec = input.exec ?? defaultExec
  const program = input.program ?? process.execPath
  try {
    if (platform === 'win32') {
      const count = Number((await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsBlockQuery(program)], { timeoutMs: 15_000 })).trim())
      if (count > 0) {
        return {
          state: 'blocked',
          message: `Windows Firewall blocks ${program}. Open Windows Security → Firewall & network protection → Allow an app through firewall, and allow it on Private networks.`,
          commands: [],
        }
      }
      return { state: 'ok', message: 'Windows asks once whether ADF may accept connections. Choose Allow on private networks.', commands: [] }
    }
    if (platform === 'darwin') {
      const tool = '/usr/libexec/ApplicationFirewall/socketfilterfw'
      const global = await exec(tool, ['--getglobalstate'])
      // "Firewall is enabled. (State = 1)" / "Firewall is disabled. (State = 0)"
      if (!/\benabled\b/i.test(global)) return { state: 'ok', message: 'The macOS firewall is off.', commands: [] }
      const blockAll = await exec(tool, ['--getblockall'])
      // "Firewall has block all state set to enabled." / "Block all DISABLED!"
      if (/\benabled\b/i.test(blockAll)) {
        return { state: 'blocked', message: 'The macOS firewall blocks all incoming connections. Turn off "Block all incoming connections" in System Settings → Network → Firewall → Options.', commands: [] }
      }
      const app = await exec(tool, ['--getappblocked', program])
      if (/is blocked/i.test(app)) {
        return { state: 'blocked', message: `The macOS firewall blocks ${program}. Allow it in System Settings → Network → Firewall → Options.`, commands: [] }
      }
      return { state: 'ok', message: 'macOS may ask once whether ADF may accept incoming connections. Choose Allow.', commands: [] }
    }
  } catch (err) {
    return { state: 'unknown', message: `Could not read the firewall state (${err instanceof Error ? err.message : String(err)}).`, commands: platform === 'linux' ? linuxFirewallCommands(input.port) : [] }
  }
  return {
    state: 'unknown',
    message: `Linux does not ask. If ufw or firewalld runs, allow port ${input.port} from your network.`,
    commands: linuxFirewallCommands(input.port),
  }
}
