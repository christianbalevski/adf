/**
 * The one confirmation for risky actions: a title, what will happen, and a
 * button named for the action ("Replace owner", "Allow host access"), never
 * OK or Yes. Cancel is always there. Low-risk removals use an Undo toast
 * instead (settings-save.tsx).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** A statement the user must tick before the button works: an explicit acceptance of the risk. */
  acknowledge?: string
}

export function ConfirmDialog({ options, onAnswer }: { options: ConfirmOptions | null; onAnswer: (confirmed: boolean) => void }) {
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => { setAcknowledged(false) }, [options])
  const blocked = !!options?.acknowledge && !acknowledged
  return (
    <Dialog open={!!options} onClose={() => onAnswer(false)} title={options?.title ?? ''} lightDismiss={false}>
      <div className="space-y-4">
        <div className="text-[13px] leading-5 text-[var(--adf-ui-text-muted)]">{options?.body}</div>
        {options?.acknowledge && (
          <label className="flex items-start gap-2 text-[13px] leading-5 text-[var(--adf-ui-text)]">
            <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>{options.acknowledge}</span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onAnswer(false)} variant="ghost">Cancel</Button>
          <Button onClick={() => onAnswer(true)} variant={options?.danger ? 'danger' : 'primary'} disabled={blocked} autoFocus={!options?.acknowledge}>
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

/** Running every MCP server on this computer (settings.compute.mcpOnHost): an explicit acceptance. */
export const MCP_ON_HOST_CONFIRM: ConfirmOptions = {
  title: 'Run MCP servers on the host',
  body: 'MCP servers will run directly on the host instead of in a container, including servers your agents install. They can read and change your files, use your network, and run programs as you. This also turns on Host access: agents given host access, and approved servers, run on the host too. Servers set to run in the container, and agents with their own container, stay in a container.',
  acknowledge: 'I understand the risk, and accept it for every MCP server.',
  confirmLabel: 'Run on the host',
  danger: true,
}
