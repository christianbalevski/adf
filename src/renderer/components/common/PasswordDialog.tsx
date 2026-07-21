import { useState, useCallback, useRef } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { Button, TextInput } from '../ui'

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

      <TextInput
        id="password-dialog-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter password"
        autoFocus
        aria-invalid={!!error}
        aria-describedby={error ? 'password-dialog-error' : undefined}
        className="mb-2 text-sm"
      />

      {error && (
        <p id="password-dialog-error" className="mb-3 text-xs text-[var(--adf-ui-danger)]">{error}</p>
      )}

      <div className="flex justify-between items-center mt-4">
        <Button
          onClick={handleWipe}
          variant="danger"
          size="compact"
        >
          Wipe All Keys
        </Button>
        <div className="flex gap-2">
          <Button
            onClick={handleCancel}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUnlock}
            disabled={!password || loading}
            loading={loading}
            variant="primary"
          >
            {loading ? 'Unlocking...' : 'Unlock'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
