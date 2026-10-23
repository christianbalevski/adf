/**
 * Settings → Identity → Secret storage (SettingsPage.tsx SecretStorageGroup):
 * the plain-text choice and its warning stay visible for as long as it is
 * saved; switching back is offered, and enabled only with a working keychain.
 * The real Electron run (RESULT.md screenshots) covers the rendered page.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SecretStorageGroup } from '../../../src/renderer/components/settings/SettingsPage'
import type { SecretStorageView } from '../../../src/shared/types/secret-storage.types'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { STUDIO_CALL_CHANNELS } from '../../../src/shared/constants/studio-call-channels'

;(globalThis as { React?: typeof React }).React = React

const render = (view: SecretStorageView, remoteName: string | null = null) =>
  renderToStaticMarkup(<SecretStorageGroup view={view} remoteName={remoteName} onUseKeyring={async () => undefined} onCheckAgain={() => {}} />)

describe('Secret storage group', () => {
  it('plain text: badge, warning and a disabled switch back while the keychain is unavailable', () => {
    const html = render({ policy: 'plaintext', keyringAvailable: false, plaintextSecrets: 4, writesBlocked: false, storedSecrets: 4, scope: 'inside-studio' })
    expect(html).toContain('Unencrypted')
    expect(html).toContain('can copy your seed phrase and keys and act as you')
    expect(html).toContain('4 secrets stored as plain text now.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Encrypt with Keychain<\/button>/)
    expect(html).toContain('Check Again')
  })

  it('plain text with a working keychain: the warning stays, and the switch back is enabled', () => {
    const html = render({ policy: 'plaintext', keyringAvailable: true, plaintextSecrets: 4, writesBlocked: false, storedSecrets: 4, scope: 'inside-studio' })
    expect(html).toContain('can copy your seed phrase and keys and act as you')
    expect(html).toMatch(/<button[^>]*>Encrypt with Keychain<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Encrypt with Keychain<\/button>/)
    expect(html).not.toContain('Check Again')
  })

  it('keychain: encrypted, nothing to switch; a lost keychain says writes are blocked', () => {
    const ok = render({ policy: 'keyring', keyringAvailable: true, plaintextSecrets: 0, writesBlocked: false, storedSecrets: 4, scope: 'inside-studio' })
    expect(ok).toContain('Encrypted with the system keychain.')
    expect(ok).not.toContain('Encrypt with Keychain')
    const lost = render({ policy: 'keyring', keyringAvailable: false, plaintextSecrets: 0, writesBlocked: true, storedSecrets: 3, scope: 'inside-studio' })
    expect(lost).toContain('Keychain unavailable')
    expect(lost).toContain('Nothing is stored unencrypted.')
  })

  it('Local mode: Studio\'s own copies, with the plain-text warning and the switch back, not hidden behind the daemon', () => {
    const html = render({ policy: 'plaintext', keyringAvailable: true, plaintextSecrets: 3, writesBlocked: false, storedSecrets: 3, scope: 'studio-copies' })
    expect(html).toContain('Agents run on the ADF daemon, which keeps its own secrets. Studio&#x27;s settings file still holds 3 secrets of its own')
    expect(html).toContain('can copy your seed phrase and keys and act as you')
    expect(html).toMatch(/<button[^>]*>Encrypt with Keychain<\/button>/)
  })

  it('a remote runtime picked in Settings: Studio\'s own plain-text secrets stay visible, worded as this computer\'s, never the remote\'s', () => {
    const html = render({ policy: 'plaintext', keyringAvailable: false, plaintextSecrets: 3, writesBlocked: false, storedSecrets: 3, scope: 'studio-copies' }, 'box-1')
    expect(html).toContain('Studio&#x27;s own secrets, in its settings file on this computer, not box-1&#x27;s. box-1 keeps its secrets on that computer; nothing here moves or changes them.')
    expect(html).not.toContain('Agents run on the ADF daemon')
    expect(html).toContain('Unencrypted')
    expect(html).toContain('can copy your seed phrase and keys and act as you')
    expect(html).toContain('Check Again')
  })
})

/**
 * IdentityTab is not rendered here (static markup runs no effects, and the
 * repo has no DOM test environment), so its placement is pinned in source:
 * the group is gated on Studio's view alone, never on the picked runtime.
 */
describe('Identity tab placement', () => {
  const source = readFileSync(join(__dirname, '../../../src/renderer/components/settings/SettingsPage.tsx'), 'utf-8')
  const tab = source.slice(source.indexOf('function IdentityTab('), source.indexOf('title="Owner identity"', source.indexOf('function IdentityTab(')))

  it('renders the group in every mode, before Owner identity, with the remote named when one is picked', () => {
    expect(tab).toContain('{secretStorage && (\n        <SecretStorageGroup view={secretStorage} remoteName={remote ? runtimeName : null}')
    expect(tab).not.toMatch(/secretStorage && !remote/)
    expect(tab).toContain('api?.getStudioSecretStorage?.().then(setSecretStorage)')
  })

  it('a facade bound to a remote sends the secret-storage calls untagged, to Studio itself', () => {
    expect(STUDIO_CALL_CHANNELS).toContain(IPC.STUDIO_SECRET_STORAGE_GET)
    expect(STUDIO_CALL_CHANNELS).toContain(IPC.STUDIO_SECRET_STORAGE_USE_KEYRING)
  })
})
