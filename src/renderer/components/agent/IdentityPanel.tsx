import { useState, useEffect, useCallback } from 'react'
import { Dialog } from '../common/Dialog'
import { useDocumentStore } from '../../stores/document.store'

interface IdentityEntry {
  purpose: string
  encrypted: boolean
  code_access: boolean
}

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
  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [addKeyPurpose, setAddKeyPurpose] = useState('')
  const [addKeyValue, setAddKeyValue] = useState('')
  const [addKeyError, setAddKeyError] = useState('')

  const refresh = useCallback(async () => {
    const [didResult, entriesResult, pwResult] = await Promise.all([
      window.adfApi.getDid(),
      window.adfApi.listIdentityEntries(),
      window.adfApi.checkPassword()
    ])
    setDid(didResult.did)
    setEntries(entriesResult.entries)
    setIsProtected(pwResult.needsPassword)
    setRevealed({})
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
