import { useState, useEffect, useCallback } from 'react'
import { Dialog } from '../common/Dialog'
import { Tooltip } from '../common/Tooltip'
import { useDocumentStore } from '../../stores/document.store'

interface IdentityEntry {
  purpose: string
  encrypted: boolean
  code_access: boolean
}

interface AttestationEntry {
  issuer: string
  subject: string
  role: string
  issued_at: string
  expires_at?: string
  scope?: string
  signature: string
}

type EnvelopeState = 'absent' | 'unlocked' | 'locked' | 'foreign'

interface EnvelopeStatus {
  identity: EnvelopeState
  credentials: EnvelopeState
  sharePasswordSet: boolean
}

const ENVELOPE_BADGE: Record<EnvelopeState, { label: string; cls: string; tip: string }> = {
  unlocked: {
    label: 'Protected',
    cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    tip: 'Encrypted at rest and sealed to your owner and runtime keys — readable on this machine, unreadable if the file leaks.',
  },
  locked: {
    label: 'Password locked',
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    tip: 'Encrypted, openable with the share password the sender set. Unlocking adopts the contents under your keys.',
  },
  foreign: {
    label: 'Foreign',
    cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    tip: 'Sealed to another owner’s keys and no share password exists — this machine cannot decrypt it.',
  },
  absent: {
    label: 'Not protected',
    cls: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
    tip: 'No envelope exists — values are stored without at-rest encryption.',
  },
}

const ENVELOPE_LABEL_TIPS = {
  identity: 'The agent’s signing key — what makes its DID provable. Sealed to your owner/runtime keys only; never shareable by password.',
  credentials: 'API keys and other secrets stored via set_identity. This envelope can carry a share password so the file can travel.',
}

const ROLE_TIPS: Record<string, string> = {
  owner: 'Signed by your owner key (derived from your seed phrase): “I own this agent.” Replaced when the agent is re-keyed or claimed.',
  operator: 'Signed by this install’s runtime key: “this installation operates the agent.” Replaced when the agent is re-keyed or claimed.',
  clone: 'Owner-signed provenance from a claim: this identity replaced a prior one. The previous DID is recorded below. Permanent.',
  rotation: 'Owner-signed record of a key rotation — the DID changed but it’s the same agent. Permanent.',
  runtime: 'Owner-signed delegation certifying a runtime key acts for this owner.',
}
const PEER_ROLE_TIP =
  'Peer attestation: another agent signed this statement about this agent. The role’s meaning is defined by the issuing peer, not the runtime.'

export function IdentityPanel() {
  const filePath = useDocumentStore((s) => s.filePath)
  const [did, setDid] = useState<string | null>(null)
  const [entries, setEntries] = useState<IdentityEntry[]>([])
  const [isProtected, setIsProtected] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [passwordDialogMode, setPasswordDialogMode] = useState<'set' | 'change' | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [attestations, setAttestations] = useState<AttestationEntry[]>([])
  const [publishOnCard, setPublishOnCard] = useState(false)
  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [addKeyPurpose, setAddKeyPurpose] = useState('')
  const [addKeyValue, setAddKeyValue] = useState('')
  const [addKeyError, setAddKeyError] = useState('')
  const [envelope, setEnvelope] = useState<EnvelopeStatus | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [sharePassword, setSharePassword] = useState('')
  const [shareError, setShareError] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockError, setUnlockError] = useState('')

  const refresh = useCallback(async () => {
    const [didResult, entriesResult, pwResult, attResult, config, envResult] = await Promise.all([
      window.adfApi.getDid(),
      window.adfApi.listIdentityEntries(),
      window.adfApi.checkPassword(),
      window.adfApi.getAgentAttestations(),
      window.adfApi.getAgentConfig(),
      window.adfApi.getEnvelopeStatus()
    ])
    setDid(didResult.did)
    setEntries(entriesResult.entries)
    setIsProtected(pwResult.needsPassword)
    setAttestations(attResult.attestations)
    setPublishOnCard(!!config?.card?.publish_attestations)
    setEnvelope(envResult.success ? {
      identity: (envResult.identity ?? 'absent') as EnvelopeState,
      credentials: (envResult.credentials ?? 'absent') as EnvelopeState,
      sharePasswordSet: !!envResult.sharePasswordSet
    } : null)
    setRevealed({})
  }, [])

  const handleReissueAttestations = useCallback(async () => {
    const result = await window.adfApi.reissueAgentAttestations()
    if (result.success && result.attestations) {
      setAttestations(result.attestations)
    }
  }, [])

  const handleTogglePublish = useCallback(async () => {
    const config = await window.adfApi.getAgentConfig()
    if (!config) return
    const enabled = !config.card?.publish_attestations
    await window.adfApi.setAgentConfig({
      ...config,
      card: { ...(config.card ?? {}), publish_attestations: enabled || undefined }
    })
    setPublishOnCard(enabled)
  }, [])

  useEffect(() => {
    refresh()
  }, [filePath, refresh])

  const handleReveal = useCallback(async (purpose: string) => {
    if (revealed[purpose] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[purpose]
        return next
      })
      return
    }
    const result = await window.adfApi.revealIdentity(purpose)
    if (result.value !== null) {
      setRevealed((prev) => ({ ...prev, [purpose]: result.value! }))
    }
  }, [revealed])

  const handleDeleteEntry = useCallback(async (purpose: string) => {
    const ok = window.confirm(`Delete identity entry "${purpose}"?`)
    if (!ok) return
    await window.adfApi.deleteIdentity(purpose)
    await refresh()
  }, [refresh])

  const handleWipeAll = useCallback(async () => {
    const ok = window.confirm(
      'Wipe all identity keys?\n\n' +
      'This will permanently delete all stored keys, secrets, and the DID.\n\n' +
      'This cannot be undone.'
    )
    if (!ok) return
    await window.adfApi.wipeAllIdentity()
    await refresh()
  }, [refresh])

  const handleSetPassword = useCallback(async () => {
    if (!newPassword) {
      setPasswordError('Password cannot be empty')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }
    let result
    if (passwordDialogMode === 'change') {
      result = await window.adfApi.changePassword(newPassword)
    } else {
      result = await window.adfApi.setPassword(newPassword)
    }
    if (result.success) {
      setPasswordDialogMode(null)
      setNewPassword('')
      setConfirmPassword('')
      setPasswordError('')
      await refresh()
    } else {
      setPasswordError(result.error || 'Failed')
    }
  }, [newPassword, confirmPassword, passwordDialogMode, refresh])

  const handleRemovePassword = useCallback(async () => {
    const ok = window.confirm('Remove password protection? All identity entries will be stored in plain text.')
    if (!ok) return
    const result = await window.adfApi.removePassword()
    if (result.success) {
      await refresh()
    }
  }, [refresh])

  const handleToggleCodeAccess = useCallback(async (purpose: string, currentValue: boolean) => {
    await window.adfApi.setIdentityCodeAccess(purpose, !currentValue)
    setEntries((prev) => prev.map((e) =>
      e.purpose === purpose ? { ...e, code_access: !currentValue } : e
    ))
  }, [])

  const handleCopyDid = useCallback(() => {
    if (did) navigator.clipboard.writeText(did)
  }, [did])

  const handleSetSharePassword = useCallback(async () => {
    const result = await window.adfApi.setSharePassword(sharePassword)
    if (result.success) {
      setShareOpen(false)
      setSharePassword('')
      setShareError('')
      await refresh()
    } else {
      setShareError(result.error || 'Failed to set share password')
    }
  }, [sharePassword, refresh])

  const handleRemoveSharePassword = useCallback(async () => {
    await window.adfApi.removeSharePassword()
    await refresh()
  }, [refresh])

  const handleUnlockCredentials = useCallback(async () => {
    const result = await window.adfApi.unlockEnvelopeWithPassword(unlockPassword)
    if (result.success) {
      setUnlockPassword('')
      setUnlockError('')
      await refresh()
    } else {
      setUnlockError(result.error || 'Wrong password')
    }
  }, [unlockPassword, refresh])

  const handleGenerateKeys = useCallback(async () => {
    const result = await window.adfApi.generateIdentityKeys()
    if (result.success) {
      await refresh()
    }
  }, [refresh])

  const handleAddKey = useCallback(async () => {
    const purpose = addKeyPurpose.trim()
    if (!purpose) {
      setAddKeyError('Purpose is required')
      return
    }
    if (entries.some((e) => e.purpose === purpose)) {
      setAddKeyError('A key with this purpose already exists')
      return
    }
    if (!addKeyValue) {
      setAddKeyError('Value is required')
      return
    }
    await window.adfApi.setIdentity(purpose, addKeyValue)
    setAddKeyOpen(false)
    setAddKeyPurpose('')
    setAddKeyValue('')
    setAddKeyError('')
    await refresh()
  }, [addKeyPurpose, addKeyValue, entries, refresh])

  return (
    <div className="h-full overflow-y-auto p-4 space-y-5">
      {/* DID */}
      <section>
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">DID</h3>
        {did ? (
          <div className="flex items-start gap-2">
            <code className="flex-1 text-[11px] text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded px-2 py-1.5 break-all select-all">
              {did}
            </code>
            <button
              onClick={handleCopyDid}
              className="shrink-0 px-2 py-1 text-[10px] text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
              title="Copy DID"
            >
              Copy
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-xs text-neutral-400">No DID generated</p>
            <button
              onClick={handleGenerateKeys}
              className="px-3 py-1 text-[11px] bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Generate Keys
            </button>
          </div>
        )}
      </section>

      {/* Envelope protection */}
      {envelope && envelope.identity !== 'absent' && (
        <section>
          <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">Envelopes</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Tooltip tip={ENVELOPE_LABEL_TIPS.identity}>
                <span className="text-xs text-neutral-600 dark:text-neutral-300 cursor-help">Identity keys</span>
              </Tooltip>
              <Tooltip tip={ENVELOPE_BADGE[envelope.identity].tip}>
                <span className={`text-[10px] px-1.5 py-0.5 rounded cursor-help ${ENVELOPE_BADGE[envelope.identity].cls}`}>
                  {ENVELOPE_BADGE[envelope.identity].label}
                </span>
              </Tooltip>
            </div>
            <div className="flex items-center justify-between">
              <Tooltip tip={ENVELOPE_LABEL_TIPS.credentials}>
                <span className="text-xs text-neutral-600 dark:text-neutral-300 cursor-help">Credentials</span>
              </Tooltip>
              <Tooltip tip={ENVELOPE_BADGE[envelope.credentials].tip}>
                <span className={`text-[10px] px-1.5 py-0.5 rounded cursor-help ${ENVELOPE_BADGE[envelope.credentials].cls}`}>
                  {ENVELOPE_BADGE[envelope.credentials].label}
                </span>
              </Tooltip>
            </div>

            {envelope.identity === 'foreign' && (
              <p className="text-[11px] text-red-600 dark:text-red-400">
                This file&apos;s identity belongs to another owner. Claim the agent (Config → Security)
                to give it a fresh identity under your ownership — its history and files are kept.
              </p>
            )}

            {/* Share password — sender side (credentials unlocked) */}
            {envelope.credentials === 'unlocked' && (
              envelope.sharePasswordSet ? (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-amber-600 dark:text-amber-400">
                    Share password set — anyone with the file and password gets its credentials.
                  </span>
                  <button
                    onClick={handleRemoveSharePassword}
                    className="shrink-0 px-2 py-1 text-[10px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                  >
                    Remove
                  </button>
                </div>
              ) : shareOpen ? (
                <div className="space-y-1.5">
                  <input
                    type="password"
                    value={sharePassword}
                    onChange={(e) => setSharePassword(e.target.value)}
                    placeholder="Share password (min 8 characters)"
                    className="w-full px-2 py-1 text-xs bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded"
                  />
                  {shareError && <p className="text-[10px] text-red-500">{shareError}</p>}
                  <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                    Lets someone you send this file to unlock its stored credentials (API keys) with
                    this password. Identity is never transferable — on their machine the agent gets a
                    new DID. Revoking access later means rotating the keys upstream.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={handleSetSharePassword} className="px-2 py-1 text-[10px] bg-blue-500 text-white rounded hover:bg-blue-600">Set</button>
                    <button onClick={() => { setShareOpen(false); setSharePassword(''); setShareError('') }} className="px-2 py-1 text-[10px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded">Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShareOpen(true)}
                  className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Set a share password…
                </button>
              )
            )}

            {/* Unlock — recipient side (credentials locked with a share password) */}
            {envelope.credentials === 'locked' && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  This file&apos;s credentials are locked with a share password. Unlocking adopts them
                  under your identity and removes the password.
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={unlockPassword}
                    onChange={(e) => setUnlockPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleUnlockCredentials() }}
                    placeholder="Share password"
                    className="flex-1 px-2 py-1 text-xs bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded"
                  />
                  <button onClick={handleUnlockCredentials} className="px-2 py-1 text-[10px] bg-blue-500 text-white rounded hover:bg-blue-600">Unlock</button>
                </div>
                {unlockError && <p className="text-[10px] text-red-500">{unlockError}</p>}
              </div>
            )}

            {envelope.credentials === 'foreign' && (
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                Stored credentials are sealed to another owner and cannot be read on this machine.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Attestations */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
              Attestations ({attestations.length})
            </h3>
            <Tooltip tip={publishOnCard
              ? 'Attestations are published on this agent’s card — mesh peers can verify ownership. Click to make private.'
              : 'Attestations are private — the agent card omits them, so peers cannot link this agent to you. Click to publish.'}
            >
              <button
                onClick={handleTogglePublish}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  publishOnCard
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50'
                    : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700'
                }`}
              >
                {publishOnCard ? 'On card' : 'Private'}
              </button>
            </Tooltip>
          </div>
          {did && (
            <button
              onClick={handleReissueAttestations}
              className="px-2 py-0.5 text-[10px] text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
            >
              Re-issue
            </button>
          )}
        </div>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-2">
          Signed proofs of who owns and operates this agent. The badge shows whether they are published on the
          agent card (also toggleable in Config → Security).
        </p>
        {attestations.length === 0 ? (
          <p className="text-xs text-neutral-400">No attestations</p>
        ) : (
          <div className="space-y-1">
            {attestations.map((att, i) => {
              const expired = !!att.expires_at && Date.parse(att.expires_at) <= Date.now()
              const stale = did !== null && att.subject !== did
              const isLineage = att.role === 'clone' || att.role === 'rotation'
              return (
                <div key={i} className="px-2 py-1.5 rounded bg-neutral-50 dark:bg-neutral-800">
                  <div className="flex items-center gap-2">
                    <Tooltip tip={ROLE_TIPS[att.role] ?? PEER_ROLE_TIP}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium cursor-help">
                        {att.role}
                      </span>
                    </Tooltip>
                    <Tooltip tip="Issued">
                      <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                        {new Date(att.issued_at).toLocaleDateString()}
                      </span>
                    </Tooltip>
                    {(expired || stale) && (
                      <Tooltip tip={expired
                        ? 'Past its expires_at date — no longer valid.'
                        : 'Its subject is not this agent’s current DID — it refers to a previous identity. Re-issue to refresh owner/operator proofs.'}
                      >
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 cursor-help">
                          {expired ? 'expired' : 'stale'}
                        </span>
                      </Tooltip>
                    )}
                  </div>
                  <Tooltip tip="Issuer — the identity that signed this attestation" className="block">
                    <div className="text-[10px] font-mono text-neutral-500 dark:text-neutral-400 break-all mt-0.5">
                      <span className="font-sans text-neutral-400 dark:text-neutral-500 select-none">by </span>
                      {att.issuer}
                    </div>
                  </Tooltip>
                  {isLineage && att.scope && (
                    <Tooltip tip="The previous DID this identity replaced" className="block">
                      <div className="text-[10px] font-mono text-neutral-500 dark:text-neutral-400 break-all mt-0.5">
                        <span className="font-sans text-neutral-400 dark:text-neutral-500 select-none">over </span>
                        {att.scope}
                      </div>
                    </Tooltip>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Password Status */}
      <section>
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">Password</h3>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full ${
            isProtected
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
          }`}>
            {isProtected ? 'Protected' : 'Unprotected'}
          </span>
          {isProtected ? (
            <div className="flex gap-2">
              <button
                onClick={() => { setPasswordDialogMode('change'); setNewPassword(''); setConfirmPassword(''); setPasswordError('') }}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                Change
              </button>
              <button
                onClick={handleRemovePassword}
                className="text-[11px] text-red-500 hover:underline"
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setPasswordDialogMode('set'); setNewPassword(''); setConfirmPassword(''); setPasswordError('') }}
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              Set Password
            </button>
          )}
        </div>
      </section>

      {/* Entries Table */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
            Entries ({entries.length})
          </h3>
          <button
            onClick={() => { setAddKeyOpen(true); setAddKeyPurpose(''); setAddKeyValue(''); setAddKeyError('') }}
            className="px-2 py-0.5 text-[10px] text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
          >
            + Add Key
          </button>
        </div>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-2">
          <span className="text-amber-500 dark:text-amber-400">Locked</span> = agent code cannot access &nbsp; <span className="text-neutral-500 dark:text-neutral-400">Unlocked</span> = agent code can read via get_identity
        </p>
        {entries.length === 0 ? (
          <p className="text-xs text-neutral-400">No identity entries</p>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => (
              <div
                key={entry.purpose}
                className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                <button
                  onClick={() => handleToggleCodeAccess(entry.purpose, entry.code_access)}
                  className={`shrink-0 transition-colors ${
                    entry.code_access
                      ? 'text-neutral-300 dark:text-neutral-600 hover:text-neutral-400 dark:hover:text-neutral-500'
                      : 'text-amber-500 dark:text-amber-400'
                  }`}
                  title={entry.code_access
                    ? 'Unlocked \u2014 agent code can read this key. Click to lock.'
                    : 'Locked \u2014 agent code cannot read this key. Click to unlock.'}
                >
                  {entry.code_access ? (
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                    </svg>
                  ) : (
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  )}
                </button>
                <span className="flex-1 text-[11px] font-mono text-neutral-700 dark:text-neutral-300 truncate" title={entry.purpose}>
                  {entry.purpose}
                </span>
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate max-w-[100px]">
                  {revealed[entry.purpose] !== undefined
                    ? revealed[entry.purpose]
                    : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                </span>
                <button
                  onClick={() => handleReveal(entry.purpose)}
                  className="shrink-0 text-[10px] text-blue-600 dark:text-blue-400 hover:underline opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  {revealed[entry.purpose] !== undefined ? 'Hide' : 'Reveal'}
                </button>
                <button
                  onClick={() => handleDeleteEntry(entry.purpose)}
                  className="shrink-0 text-[10px] text-red-500 hover:underline opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Danger Zone — pushed to bottom with spacer */}
      {entries.length > 0 && (
        <>
          <div className="pt-6" />
          <section>
            <h3 className="text-xs font-semibold text-red-500 uppercase tracking-wide mb-2">Danger Zone</h3>
            <button
              onClick={handleWipeAll}
              className="px-3 py-1.5 text-xs text-red-600 border border-red-300 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              Wipe All Keys
            </button>
          </section>
        </>
      )}

      {/* Add Key Dialog */}
      <Dialog
        open={addKeyOpen}
        onClose={() => setAddKeyOpen(false)}
        title="Add Identity Key"
      >
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">Purpose</label>
            <input
              type="text"
              value={addKeyPurpose}
              onChange={(e) => setAddKeyPurpose(e.target.value)}
              placeholder="e.g. provider:openrouter:apiKey"
              autoFocus
              className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">Value</label>
            <input
              type="password"
              value={addKeyValue}
              onChange={(e) => setAddKeyValue(e.target.value)}
              placeholder="Secret value"
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddKey() }}
              className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {addKeyError && (
            <p className="text-xs text-red-500">{addKeyError}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setAddKeyOpen(false)}
              className="px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleAddKey}
              disabled={!addKeyPurpose.trim() || !addKeyValue}
              className="px-4 py-1.5 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </Dialog>

      {/* Set/Change Password Dialog */}
      <Dialog
        open={passwordDialogMode !== null}
        onClose={() => setPasswordDialogMode(null)}
        title={passwordDialogMode === 'change' ? 'Change Password' : 'Set Password'}
      >
        <div className="space-y-3">
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password"
            autoFocus
            className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSetPassword() }}
            className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {passwordError && (
            <p className="text-xs text-red-500">{passwordError}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPasswordDialogMode(null)}
              className="px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleSetPassword}
              disabled={!newPassword}
              className="px-4 py-1.5 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {passwordDialogMode === 'change' ? 'Change' : 'Set'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
