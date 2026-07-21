import { describe, expect, it } from 'vitest'
import {
  buildLinuxApplyCommand,
  buildWindowsApplyScript,
  buildWindowsCheckScript,
  buildWindowsElevatedLauncher,
  encodePwsh,
  FW_RULE_TCP,
  FW_RULE_UDP,
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

  describe('buildWindowsApplyScript', () => {
    it('opens both the mesh TCP port and mDNS UDP, program-scoped to Private/Domain', () => {
      const s = buildWindowsApplyScript(7295, 'C:\\Program Files\\ADF Studio\\ADF Studio.exe')
      expect(s).toContain(`-Protocol TCP -LocalPort 7295`)
      expect(s).toContain(`-Protocol UDP -LocalPort ${MDNS_PORT}`)
      expect(s).toContain('-Profile Private,Domain')
      expect(s).toContain(`-Program 'C:\\Program Files\\ADF Studio\\ADF Studio.exe'`)
      expect(s).toContain(FW_RULE_TCP)
      expect(s).toContain(FW_RULE_UDP)
    })

    it('is idempotent — removes prior rules before recreating', () => {
      const s = buildWindowsApplyScript(9000, 'C:\\app.exe')
      expect(s).toContain('Remove-NetFirewallRule')
      expect(s).toContain('-LocalPort 9000')
    })

    it('never opens the Public profile', () => {
      const s = buildWindowsApplyScript(7295, 'C:\\app.exe')
      expect(s).not.toMatch(/Profile\s+\w*Public/)
    })

    it("escapes single quotes in the exe path so they can't break the string literal", () => {
      const s = buildWindowsApplyScript(7295, "C:\\o'brien\\app.exe")
      expect(s).toContain("C:\\o''brien\\app.exe")
    })
  })

  describe('buildWindowsElevatedLauncher', () => {
    it('wraps the inner script in Start-Process -Verb RunAs and maps cancel to 1223', () => {
      const launcher = buildWindowsElevatedLauncher('echo hi')
      expect(launcher).toContain('Start-Process powershell -Verb RunAs')
      expect(launcher).toContain('-EncodedCommand')
      expect(launcher).toContain('exit 1223')
    })

    it('embeds the inner script as a UTF-16LE base64 blob', () => {
      const inner = 'New-NetFirewallRule -DisplayName test'
      const launcher = buildWindowsElevatedLauncher(inner)
      expect(launcher).toContain(encodePwsh(inner))
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

  describe('encodePwsh', () => {
    it('round-trips through UTF-16LE base64', () => {
      const script = "Write-Output 'héllo'"
      const decoded = Buffer.from(encodePwsh(script), 'base64').toString('utf16le')
      expect(decoded).toBe(script)
    })
  })
})
