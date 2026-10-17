import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitKeychainAccess, TEST_KEYCHAIN_FILE_ENV } from '../../src/main/backend/daemon-secrets'

describe('awaitKeychainAccess (boot handover, before its sync keychain reads)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('logs before and after a quick read, and shows nothing', async () => {
    const lines: string[] = []
    const onSlow = vi.fn()
    await awaitKeychainAccess({}, { log: (l) => lines.push(l), onSlow, read: async () => 3 })
    expect(lines[0]).toMatch(/Reading the OS keychain/)
    expect(lines[1]).toMatch(/OS keychain read: 3 "ADF" item\(s\)/)
    expect(onSlow).not.toHaveBeenCalled()
  })

  it('a read still waiting (a macOS prompt) is logged and shown, and the boot carries on when it returns', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const onSlow = vi.fn()
    let answer!: (n: number) => void
    const done = awaitKeychainAccess({}, { log: (l) => lines.push(l), onSlow, slowAfterMs: 5_000, read: () => new Promise((r) => { answer = r }) })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onSlow).toHaveBeenCalledOnce()
    expect(lines.at(-1)).toMatch(/Still waiting on the OS keychain after 5 s/)
    answer(2)
    await done
    expect(lines.at(-1)).toMatch(/OS keychain read: 2/)
  })

  it('a failed read is logged, not thrown', async () => {
    const lines: string[] = []
    await expect(awaitKeychainAccess({}, { log: (l) => lines.push(l), onSlow: () => {}, read: async () => { throw new Error('denied') } })).resolves.toBeUndefined()
    expect(lines.at(-1)).toMatch(/read failed \(denied\)/)
  })

  it('does nothing where the daemon would not use the real keychain', async () => {
    const read = vi.fn(async () => 1)
    for (const env of [{ ADF_SECRET_STORE: 'file' }, { ADF_KEYCHAIN: '0' }, { [TEST_KEYCHAIN_FILE_ENV]: '/tmp/k.json' }]) {
      await awaitKeychainAccess(env, { log: () => {}, onSlow: () => {}, read })
    }
    expect(read).not.toHaveBeenCalled()
  })
})
