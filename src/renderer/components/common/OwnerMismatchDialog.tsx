import { useState, useCallback, useRef } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { Button } from '../ui'

export function OwnerMismatchDialog() {
  const open = useAppStore((s) => s.ownerMismatchDialogOpen)
  const fileOwnerDid = useAppStore((s) => s.ownerMismatchFileOwnerDid)
  const setOpen = useAppStore((s) => s.setOwnerMismatchDialogOpen)
  const [loading, setLoading] = useState(false)
  const { completeFileOpen, closeFile } = useAdfFile()
  const successRef = useRef(false)

  const handleClaim = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.adfApi.claimAgent()
      if (result.success) {
        successRef.current = true
        setOpen(false)
        await completeFileOpen()
      }
    } catch {
      // If claim fails, just close
      await closeFile()
    } finally {
      setLoading(false)
    }
  }, [setOpen, completeFileOpen, closeFile])

  const handleOpenAnyway = useCallback(async () => {
    successRef.current = true
    setOpen(false)
    await completeFileOpen()
  }, [setOpen, completeFileOpen])

  const handleCancel = useCallback(async () => {
    setOpen(false)
    await closeFile()
  }, [setOpen, closeFile])

  const handleDialogClose = useCallback(async () => {
    if (successRef.current) {
      successRef.current = false
      return
    }
    await handleCancel()
  }, [handleCancel])

  return (
    <Dialog open={open} onClose={handleDialogClose} title="Different Owner">
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
        This ADF was created by a different owner. You can claim it as your own (regenerates identity keys) or open it without changing ownership.
      </p>

      {fileOwnerDid && (
        <div className="mb-4 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] p-2 ring-1 ring-inset ring-[var(--adf-ui-separator)]">
          <p className="mb-1 text-[11px] text-[var(--adf-ui-text-subtle)]">File owner DID</p>
          <code className="select-all break-all text-[11px] text-[var(--adf-ui-text)]">
            {fileOwnerDid}
          </code>
        </div>
      )}

      <div className="flex justify-between items-center mt-4">
        <Button
          onClick={handleCancel}
        >
          Cancel
        </Button>
        <div className="flex gap-2">
          <Button
            onClick={handleOpenAnyway}
          >
            Open Anyway
          </Button>
          <Button
            onClick={handleClaim}
            disabled={loading}
            loading={loading}
            variant="primary"
          >
            {loading ? 'Claiming...' : 'Claim as Mine'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
