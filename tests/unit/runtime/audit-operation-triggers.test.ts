import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

const testFile = join(tmpdir(), `adf-audit-ops-test-${Date.now()}.adf`)
let ws: AdfWorkspace | undefined
let skipAll = false

try {
  ws = AdfWorkspace.create(testFile, { name: 'audit-ops-test' })
  const config = ws.getAgentConfig()
  config.context.audit = { loop: true, inbox: true, outbox: true }
  ws.setAgentConfig(config)
} catch {
  skipAll = true
}

function cleanup(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
}

describe.skipIf(skipAll)('audit operation triggers', () => {
  afterAll(() => {
    ws?.close()
    cleanup()
  })

  // =========================================================================
  // Loop Clear
  // =========================================================================

  describe('loop clear', () => {
    it('creates an audit entry with source "loop" and the archived seq range when clearing loop', () => {
      const t1 = Date.now() - 2000
      const t2 = Date.now() - 1000
      const seq1 = ws!.appendToLoop('user', [{ type: 'text', text: 'hello' }], 'test-model', undefined, t1)
      const seq2 = ws!.appendToLoop('assistant', [{ type: 'text', text: 'hi' }], 'test-model', undefined, t2)

      ws!.clearLoop()

      const audits = ws!.listAudits()
      const loopAudit = audits.find(a => a.source === 'loop')
      expect(loopAudit).toBeDefined()
      expect(loopAudit!.source).toBe('loop')
      expect(loopAudit!.entry_count).toBe(2)
      expect(loopAudit!.start_seq).toBe(seq1)
      expect(loopAudit!.end_seq).toBe(seq2)
      expect(loopAudit!.ref).toBeNull()
      expect(loopAudit!.size_bytes).toBeGreaterThan(0)
    })

    it('does not create an audit entry when loop is empty', () => {
      const before = ws!.listAudits().length
      ws!.clearLoop()
      const after = ws!.listAudits().length
      expect(after).toBe(before)
    })
  })

  // =========================================================================
  // Loop Compact (clearLoopSlice)
  // =========================================================================

  describe('loop compact (clearLoopSlice)', () => {
    it('creates an audit entry with the deleted seq range when compacting a loop slice', () => {
      const t1 = Date.now() - 3000
      const t2 = Date.now() - 2000
      const t3 = Date.now() - 1000
      const seq1 = ws!.appendToLoop('user', [{ type: 'text', text: 'msg1' }], 'test-model', undefined, t1)
      const seq2 = ws!.appendToLoop('assistant', [{ type: 'text', text: 'msg2' }], 'test-model', undefined, t2)
      ws!.appendToLoop('user', [{ type: 'text', text: 'msg3' }], 'test-model', undefined, t3)

      const result = ws!.clearLoopSlice(0, 2) // compact first 2 entries

      expect(result.deleted).toBe(2)
      expect(result.audited).toBe(true)

      const audits = ws!.listAudits()
      const loopAudits = audits.filter(a => a.source === 'loop')
      expect(loopAudits.length).toBeGreaterThanOrEqual(1)

      const latest = loopAudits[0] // ordered by created_at DESC
      expect(latest.entry_count).toBe(2)
      expect(latest.start_seq).toBe(seq1)
      expect(latest.end_seq).toBe(seq2)

      // Remaining entry should still be in loop
      const remaining = ws!.getLoop()
      expect(remaining).toHaveLength(1)

      // Clean up
      ws!.clearLoop()
    })
  })

  // =========================================================================
  // Inbox Deletion
  // =========================================================================

  describe('inbox deletion', () => {
    it('does NOT create a batch audit entry when deleting inbox messages (per-message-only policy)', () => {
      const t1 = Date.now() - 2000
      const t2 = Date.now() - 1000
      ws!.addToInbox({
        from: 'agent-a',
        content: 'inbox message 1',
        received_at: t1,
        status: 'unread'
      })
      ws!.addToInbox({
        from: 'agent-b',
        content: 'inbox message 2',
        received_at: t2,
        status: 'unread'
      })

      const before = ws!.listAudits().length
      const result = ws!.deleteInboxByFilter({ status: 'unread' })

      expect(result.deleted).toBe(2)
      expect(result.audited).toBe(false)
      // Message content is archived per-message at arrival (auditMessage) —
      // batch clears no longer write legacy 'inbox' rows.
      expect(ws!.listAudits().length).toBe(before)
      expect(ws!.listAudits().find(a => a.source === 'inbox')).toBeUndefined()
    })

    it('does not create an audit entry when no inbox messages match filter', () => {
      const before = ws!.listAudits().length
      ws!.deleteInboxByFilter({ from: 'nonexistent-agent' })
      const after = ws!.listAudits().length
      expect(after).toBe(before)
    })
  })

  // =========================================================================
  // Outbox Deletion
  // =========================================================================

  describe('outbox deletion', () => {
    it('does NOT create a batch audit entry when deleting outbox messages (per-message-only policy)', () => {
      const t1 = Date.now() - 2000
      const t2 = Date.now() - 1000
      ws!.addToOutbox({
        from: 'self',
        to: 'agent-x',
        content: 'outbox message 1',
        created_at: t1,
        status: 'sent'
      })
      ws!.addToOutbox({
        from: 'self',
        to: 'agent-y',
        content: 'outbox message 2',
        created_at: t2,
        status: 'sent'
      })

      const before = ws!.listAudits().length
      const result = ws!.deleteOutboxByFilter({ status: 'sent' })

      expect(result.deleted).toBe(2)
      expect(result.audited).toBe(false)
      expect(ws!.listAudits().length).toBe(before)
      expect(ws!.listAudits().find(a => a.source === 'outbox')).toBeUndefined()
    })

    it('does not create an audit entry when no outbox messages match filter', () => {
      const before = ws!.listAudits().length
      ws!.deleteOutboxByFilter({ to: 'nonexistent-agent' })
      const after = ws!.listAudits().length
      expect(after).toBe(before)
    })

    it('refuses a filter that produces no WHERE clause instead of wiping the table', () => {
      ws!.addToOutbox({ from: 'self', to: 'agent-x', content: 'keep me', created_at: Date.now(), status: 'sent' })

      // `source` is an inbox-only field: the outbox WHERE builder ignores it,
      // which would otherwise degrade to DELETE FROM adf_outbox.
      expect(() => ws!.deleteOutboxByFilter({ source: 'telegram' } as never)).toThrow(/Refusing to delete every outbox row/)
      expect(() => ws!.deleteInboxByFilter({ status: '' })).toThrow(/Refusing to delete every inbox row/)

      expect(ws!.getOutbox().length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // Audit disabled
  // =========================================================================

  describe('audit disabled', () => {
    it('does not create audit entries when audit is disabled', () => {
      // Disable all audit flags
      const config = ws!.getAgentConfig()
      config.context.audit = { loop: false, inbox: false, outbox: false }
      ws!.setAgentConfig(config)

      const before = ws!.listAudits().length

      // Add and clear loop
      ws!.appendToLoop('user', [{ type: 'text', text: 'test' }], 'test-model')
      ws!.clearLoop()

      // Add and delete inbox
      ws!.addToInbox({ from: 'agent-z', content: 'msg', received_at: Date.now(), status: 'unread' })
      ws!.deleteInboxByFilter({ status: 'unread' })

      // Add and delete outbox
      ws!.addToOutbox({ from: 'self', to: 'agent-z', content: 'msg', created_at: Date.now(), status: 'pending' })
      ws!.deleteOutboxByFilter({ status: 'pending' })

      const after = ws!.listAudits().length
      expect(after).toBe(before)

      // Re-enable for any subsequent tests
      config.context.audit = { loop: true, inbox: true, outbox: true }
      ws!.setAgentConfig(config)
    })
  })

  // =========================================================================
  // Audit data is readable (brotli roundtrip)
  // =========================================================================

  describe('audit data roundtrip', () => {
    it('stored audit data can be decompressed and read back', () => {
      const t = Date.now()
      ws!.appendToLoop('user', [{ type: 'text', text: 'roundtrip test' }], 'test-model', undefined, t)
      ws!.clearLoop()

      const audits = ws!.listAudits()
      const latest = audits[0]
      expect(latest).toBeDefined()

      const data = ws!.readAudit(latest.id)
      expect(data).not.toBeNull()
      expect(Array.isArray(data)).toBe(true)
      expect(data!.length).toBeGreaterThan(0)

      const entry = data![0] as { role: string; created_at: number }
      expect(entry.role).toBe('user')
      expect(entry.created_at).toBe(t)
    })
  })

  // =========================================================================
  // Per-message audit (auditMessage)
  // =========================================================================

  describe('per-message audit', () => {
    it('creates inbox_message audit entry with ref = message id when inbox audit is enabled', () => {
      const before = ws!.listAudits().length
      const alfJson = JSON.stringify({
        version: '1.0',
        id: 'msg-001',
        from: 'did:key:sender',
        to: 'did:key:recipient',
        payload: {
          content: 'hello',
          attachments: [
            { filename: 'doc.md', content_type: 'text/markdown', transfer: 'inline', data: Buffer.from('# Title').toString('base64'), size_bytes: 7 }
          ]
        }
      })

      ws!.auditMessage('inbox', alfJson, 'msg-001')

      const audits = ws!.listAudits()
      expect(audits.length).toBe(before + 1)

      const latest = audits[0]
      expect(latest.source).toBe('inbox_message')
      expect(latest.entry_count).toBe(1)
      expect(latest.ref).toBe('msg-001')
      expect(latest.start_seq).toBeNull()
      expect(latest.end_seq).toBeNull()
      expect(latest.size_bytes).toBe(alfJson.length)

      // Verify roundtrip — decompressed data matches original
      const data = ws!.readAudit(latest.id)
      expect(data).toBeDefined()
      const restored = data as Record<string, unknown>
      expect((restored as any).id).toBe('msg-001')
      const payload = (restored as any).payload
      expect(payload.attachments[0].data).toBe(Buffer.from('# Title').toString('base64'))
    })

    it('creates outbox_message audit entry with ref when outbox audit is enabled', () => {
      const before = ws!.listAudits().length
      const alfJson = JSON.stringify({
        version: '1.0',
        id: 'msg-002',
        from: 'did:key:self',
        to: 'did:key:recipient',
        payload: {
          content: 'outgoing',
          attachments: [
            { filename: 'report.pdf', content_type: 'application/pdf', transfer: 'inline', data: 'AAAA', size_bytes: 3 }
          ]
        }
      })

      ws!.auditMessage('outbox', alfJson, 'msg-002')

      const audits = ws!.listAudits()
      expect(audits.length).toBe(before + 1)

      const latest = audits[0]
      expect(latest.source).toBe('outbox_message')
      expect(latest.entry_count).toBe(1)
      expect(latest.ref).toBe('msg-002')
    })

    it('skips audit when inbox audit is disabled', () => {
      const config = ws!.getAgentConfig()
      config.context.audit = { loop: true, inbox: false, outbox: true }
      ws!.setAgentConfig(config)

      const before = ws!.listAudits().length
      ws!.auditMessage('inbox', '{"test":true}', 'msg-x')
      expect(ws!.listAudits().length).toBe(before)

      // Restore
      config.context.audit = { loop: true, inbox: true, outbox: true }
      ws!.setAgentConfig(config)
    })

    it('skips audit when outbox audit is disabled', () => {
      const config = ws!.getAgentConfig()
      config.context.audit = { loop: true, inbox: true, outbox: false }
      ws!.setAgentConfig(config)

      const before = ws!.listAudits().length
      ws!.auditMessage('outbox', '{"test":true}', 'msg-y')
      expect(ws!.listAudits().length).toBe(before)

      // Restore
      config.context.audit = { loop: true, inbox: true, outbox: true }
      ws!.setAgentConfig(config)
    })
  })

  // =========================================================================
  // File deletion audit (ref = path)
  // =========================================================================

  describe('file deletion audit', () => {
    it('creates a file audit entry with ref = relative path', () => {
      const config = ws!.getAgentConfig()
      ;(config.context.audit as Record<string, boolean>).files = true
      ws!.setAgentConfig(config)

      ws!.writeFile('notes/scratch.md', '# scratch')
      const before = ws!.listAudits().length
      const deleted = ws!.deleteFile('notes/scratch.md')
      expect(deleted).toBe(true)

      const audits = ws!.listAudits()
      expect(audits.length).toBe(before + 1)
      const latest = audits[0]
      expect(latest.source).toBe('file')
      expect(latest.ref).toBe('notes/scratch.md')
      expect(latest.start_seq).toBeNull()
      expect(latest.end_seq).toBeNull()
    })
  })
})
