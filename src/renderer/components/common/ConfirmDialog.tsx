/**
 * The one confirmation for risky actions: a title, what will happen, and a
 * button named for the action ("Replace owner", "Allow host access"), never
 * OK or Yes. Cancel is always there. Low-risk removals use an Undo toast
 * instead (settings-save.tsx).
 */
import { useCallback, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { Button } from '../ui'

export interface ConfirmOptions {
  title: string
  /** What happens, in one or two sentences. */
  body: React.ReactNode
  /** The verb on the button: "Replace owner", "Allow host access", "Revoke". */
  confirmLabel: string
  /** Danger tone on the button (a loss), rather than primary (a grant). */
  danger?: boolean
}

export function ConfirmDialog({ options, onAnswer }: { options: ConfirmOptions | null; onAnswer: (confirmed: boolean) => void }) {
  return (
    <Dialog open={!!options} onClose={() => onAnswer(false)} title={options?.title ?? ''} lightDismiss={false}>
      <div className="space-y-4">
        <div className="text-[13px] leading-5 text-[var(--adf-ui-text-muted)]">{options?.body}</div>
        <div className="flex justify-end gap-2">
          <Button onClick={() => onAnswer(false)} variant="ghost">Cancel</Button>
          <Button onClick={() => onAnswer(true)} variant={options?.danger ? 'danger' : 'primary'} autoFocus>
            {options?.confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * `const [confirmDialog, confirm] = useConfirm()`: render `confirmDialog`
 * once, and `await confirm({...})` resolves true only when the action button
 * was pressed.
 */
export function useConfirm(): [React.ReactNode, (options: ConfirmOptions) => Promise<boolean>] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((confirmed: boolean) => void) | null>(null)
  const confirm = useCallback((next: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false)
    resolver.current = resolve
    setOptions(next)
  }), [])
  const answer = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed)
    resolver.current = null
    setOptions(null)
  }, [])
  return [<ConfirmDialog options={options} onAnswer={answer} />, confirm]
}

/** Turning on host access (Settings → Compute, and Allow on an MCP server's Runs on). */
export const HOST_ACCESS_CONFIRM: ConfirmOptions = {
  title: 'Allow host access',
  body: 'Host execution bypasses container isolation: approved MCP servers, and agents given host access, run commands directly on the host, with its files and network.',
  confirmLabel: 'Allow host access',
  danger: true,
}
