import { useState, useCallback, useRef } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useAdfFile } from '../../hooks/useAdfFile'

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
        <div className="mb-4 p-2 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">File owner DID</p>
          <code className="text-[11px] text-neutral-700 dark:text-neutral-300 break-all select-all">
            {fileOwnerDid}
          </code>
        </div>
      )}

      <div className="flex justify-between items-center mt-4">
        <button
          onClick={handleCancel}
          className="px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
        >
          Cancel
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleOpenAnyway}
            className="px-3 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Open Anyway
          </button>
          <button
            onClick={handleClaim}
            disabled={loading}
            className="px-4 py-1.5 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Claiming...' : 'Claim as Mine'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
