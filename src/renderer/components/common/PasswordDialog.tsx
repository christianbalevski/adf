import { useState, useCallback, useRef } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'

export function PasswordDialog() {
  const open = useAppStore((s) => s.passwordDialogOpen)
  const setOpen = useAppStore((s) => s.setPasswordDialogOpen)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { completeFileOpen, closeFile } = useAdfFile()
  // Track whether the dialog is closing due to a successful unlock/wipe
  // so that the native <dialog> close event doesn't also call closeFile()
  const successRef = useRef(false)

  const handleUnlock = useCallback(async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const result = await window.adfApi.unlockPassword(password)
      if (result.success) {
        successRef.current = true
        setPassword('')
        setError('')
        setOpen(false)
        await completeFileOpen()
      } else {
        setError(result.error || 'Wrong password')
      }
    } catch {
      setError('Failed to unlock')
    } finally {
      setLoading(false)
    }
  }, [password, setOpen, completeFileOpen])

  const handleWipe = useCallback(async () => {
    const confirmed = window.confirm(
      'Wipe all identity keys?\n\n' +
      'This will permanently delete all stored keys and secrets. ' +
      'The file will open with an empty identity table.\n\n' +
      'This cannot be undone.'
    )
    if (!confirmed) return
    await window.adfApi.wipeAllIdentity()
    successRef.current = true
    setPassword('')
    setError('')
    setOpen(false)
    await completeFileOpen()
  }, [setOpen, completeFileOpen])

  const handleCancel = useCallback(async () => {
    setPassword('')
    setError('')
    setOpen(false)
    await closeFile()
  }, [setOpen, closeFile])

  // Called by the native <dialog> close event (Escape, backdrop, or programmatic el.close())
  const handleDialogClose = useCallback(async () => {
    if (successRef.current) {
      // Closing after successful unlock/wipe — don't close the file
      successRef.current = false
      return
    }
    // Genuine cancel (Escape key or backdrop click)
    await handleCancel()
  }, [handleCancel])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleUnlock()
    }
  }, [handleUnlock])

  return (
    <Dialog open={open} onClose={handleDialogClose} title="Password Required">
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        This ADF file has a password-protected identity keystore.
      </p>

      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter password"
        autoFocus
        className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
      />

      {error && (
        <p className="text-xs text-red-500 mb-3">{error}</p>
      )}

      <div className="flex justify-between items-center mt-4">
        <button
          onClick={handleWipe}
          className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
        >
          Wipe All Keys
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={handleUnlock}
            disabled={!password || loading}
            className="px-4 py-1.5 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Unlocking...' : 'Unlock'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
