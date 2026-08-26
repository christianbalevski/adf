import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'

const testFile = join(tmpdir(), `adf-inbox-dedup-test-${Date.now()}.adf`)
let ws: AdfWorkspace | undefined
let skipAll = false

try {
  ws = AdfWorkspace.create(testFile, { name: 'inbox-dedup-test' })
} catch {
  skipAll = true
}

function cleanup(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = testFile + suffix
    if (existsSync(p)) try { unlinkSync(p) } catch { /* ignore */ }
  }
}

describe.skipIf(skipAll)('inbox message_id dedup index', () => {
  afterAll(() => {
    ws?.close()
    cleanup()
  })

  it('finds an existing (source, message_id) pair and misses on either differing', () => {
    ws!.addToInbox({
      from: 'telegram:U1',
      content: 'hello',
      message_id: 'chat1:42',
      source: 'telegram',
      received_at: Date.now(),
      status: 'unread'
    })

    expect(ws!.hasInboxMessage('telegram', 'chat1:42')).toBe(true)
    expect(ws!.hasInboxMessage('telegram', 'chat1:43')).toBe(false)
    expect(ws!.hasInboxMessage('slack', 'chat1:42')).toBe(false)
  })

  it('ignores rows without a message_id', () => {
    ws!.addToInbox({
      from: 'telegram:U1',
      content: 'no platform id',
      source: 'telegram',
      received_at: Date.now(),
      status: 'unread'
    })

    expect(ws!.hasInboxMessage('telegram', '')).toBe(false)
  })
})
