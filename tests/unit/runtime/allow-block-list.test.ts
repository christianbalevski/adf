import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {}
}))

import { isAllowedByList } from '../../../src/main/runtime/mesh-manager'

const ALICE = 'did:key:zAlice'
const BOB = 'did:key:zBob'
const CAROL = 'did:key:zCarol'

describe('isAllowedByList (inbound allow/block filter)', () => {
  it('passes everyone when neither list is set', () => {
    expect(isAllowedByList(ALICE)).toBe(true)
    expect(isAllowedByList(ALICE, [], [])).toBe(true)
  })

  it('block_list rejects only listed DIDs when there is no allow_list', () => {
    expect(isAllowedByList(BOB, undefined, [BOB])).toBe(false)
    expect(isAllowedByList(ALICE, undefined, [BOB])).toBe(true)
  })

  it('allow_list blocks everyone except its members', () => {
    expect(isAllowedByList(ALICE, [ALICE])).toBe(true)
    expect(isAllowedByList(BOB, [ALICE])).toBe(false)
    expect(isAllowedByList(CAROL, [ALICE])).toBe(false)
  })

  it('allow_list takes precedence over block_list', () => {
    // Allowed member is admitted even if also on the block list.
    expect(isAllowedByList(ALICE, [ALICE], [ALICE])).toBe(true)
    // Non-member is rejected regardless of the block list contents.
    expect(isAllowedByList(BOB, [ALICE], [])).toBe(false)
    expect(isAllowedByList(BOB, [ALICE], [CAROL])).toBe(false)
    // A DID absent from a non-empty allow_list is blocked even though the
    // block_list would have permitted it — allow_list is authoritative.
    expect(isAllowedByList(CAROL, [ALICE, BOB], [ALICE])).toBe(false)
  })
})
