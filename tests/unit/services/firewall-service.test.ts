import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildLinuxApplyCommand,
  buildWindowsCheckScript,
  FW_RULE_TCP,
  FW_RULE_UDP,
  lanFirewallCommands,
  MDNS_PORT,
} from '../../../src/main/services/firewall-service'

describe('firewall-service command builders', () => {
  describe('buildWindowsCheckScript', () => {
    it('queries our rule read-only and emits JSON', () => {
      const s = buildWindowsCheckScript()
      expect(s).toContain(`Get-NetFirewallRule -DisplayName '${FW_RULE_TCP}'`)
      expect(s).toContain('ConvertTo-Json')
      // Read-only: never creates or deletes.
      expect(s).not.toContain('New-NetFirewallRule')
      expect(s).not.toContain('Remove-NetFirewallRule')
    })
  })

  describe('lanFirewallCommands (R9: shown for the user to run, never run by Studio)', () => {
    it('Windows: both rules, program-scoped to Private and Domain, never Public', () => {
      const [tcp, udp] = lanFirewallCommands('win32', 7295, 'C:\\Program Files\\ADF Studio\\ADF Studio.exe')
      expect(tcp).toContain(`New-NetFirewallRule -DisplayName '${FW_RULE_TCP}'`)
      expect(tcp).toContain('-Protocol TCP -LocalPort 7295')
      expect(udp).toContain(`-Protocol UDP -LocalPort ${MDNS_PORT}`)
      expect(udp).toContain(FW_RULE_UDP)
      for (const c of [tcp, udp]) {
        expect(c).toContain("-Program 'C:\\Program Files\\ADF Studio\\ADF Studio.exe'")
        expect(c).toContain('-Profile Private,Domain')
        expect(c).not.toMatch(/Profile\s+\w*Public/)
      }
    })

    it('Windows: each add first removes any rule of the same name, so a stale (Block) rule cannot win and a re-run adds no duplicate', () => {
      const [tcp, udp] = lanFirewallCommands('win32', 7295, 'C:\\ADF\\ADF Studio.exe')
      for (const [cmd, name] of [[tcp, FW_RULE_TCP], [udp, FW_RULE_UDP]] as const) {
        expect(cmd.startsWith(`Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName '${name}' `)).toBe(true)
      }
    })

    it('Windows: a single quote in the path is doubled, so it cannot end the literal', () => {
      expect(lanFirewallCommands('win32', 7295, "C:\\o'brien\\app.exe")[0]).toContain("'C:\\o''brien\\app.exe'")
    })

    it('macOS: the application firewall allows this binary; the path is quoted for the shell', () => {
      expect(lanFirewallCommands('darwin', 7295, "/Applications/ADF Studio's.app/x")).toEqual([
        "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add '/Applications/ADF Studio'\\''s.app/x'",
        "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '/Applications/ADF Studio'\\''s.app/x'",
      ])
    })

    it('Linux: the active manager commands with sudo; none without a firewall', () => {
      expect(lanFirewallCommands('linux', 7295, '', 'ufw')).toEqual(['sudo ufw allow 7295/tcp', `sudo ufw allow ${MDNS_PORT}/udp`])
      expect(lanFirewallCommands('linux', 7295, '', 'firewalld')).toEqual([`sudo firewall-cmd --permanent --add-port=7295/tcp --add-port=${MDNS_PORT}/udp`, 'sudo firewall-cmd --reload'])
      expect(lanFirewallCommands('linux', 7295, '', null)).toEqual([])
    })

    it('the module has no elevated apply any more (no UAC, admin or pkexec prompt)', () => {
      const src = readFileSync(join(__dirname, '../../../src/main/services/firewall-service.ts'), 'utf-8')
      for (const banned of ['-Verb RunAs', 'with administrator privileges', "'pkexec'", 'applyLanFirewall']) expect(src, banned).not.toContain(banned)
    })
  })

  describe('buildLinuxApplyCommand', () => {
    it('opens both ports via firewalld with a reload', () => {
      const cmd = buildLinuxApplyCommand('firewalld', 7295)
      expect(cmd).toContain('firewall-cmd --permanent --add-port=7295/tcp')
      expect(cmd).toContain(`--add-port=${MDNS_PORT}/udp`)
      expect(cmd).toContain('firewall-cmd --reload')
    })

    it('opens both ports via ufw', () => {
      const cmd = buildLinuxApplyCommand('ufw', 9000)
      expect(cmd).toContain('ufw allow 9000/tcp')
      expect(cmd).toContain(`ufw allow ${MDNS_PORT}/udp`)
    })
  })

})
