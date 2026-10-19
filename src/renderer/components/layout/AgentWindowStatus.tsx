import { useAgentWindowStore } from '../../stores/agent-window.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { openWindowAgent } from '../../utils/agent-window'
import { closeAgentWindow } from '../../utils/window-kind'
import { Button } from '../ui'

/**
 * An agent window before its agent is open (docs/design/agent-windows.md):
 * a spinner while it opens; the error, Retry and Close window when the
 * open failed.
 */
export function AgentWindowStatus() {
  const status = useAgentWindowStore((s) => s.status)
  const error = useAgentWindowStore((s) => s.error)
  const { openFile } = useAdfFile()
  return <AgentWindowStatusView status={status} error={error} onRetry={() => { void openWindowAgent(openFile) }} onClose={closeAgentWindow} />
}

export function AgentWindowStatusView({ status, error, onRetry, onClose }: { status: 'opening' | 'failed'; error: string | null; onRetry: () => void; onClose: () => void }) {
  if (status === 'opening') {
    return (
      <div className="h-full w-full flex items-center justify-center" role="status" aria-label="Opening the agent">
        <svg className="h-8 w-8 animate-spin text-neutral-400 dark:text-neutral-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex items-center justify-center p-8" role="alert">
      <div className="max-w-md flex flex-col items-center gap-4 text-center">
        <p className="text-sm font-medium text-[var(--adf-ui-text)]">The agent did not open.</p>
        {error && <p className="text-xs text-[var(--adf-ui-text-muted)] break-words">{error}</p>}
        <div className="flex gap-2">
          <Button variant="primary" onClick={onRetry}>Retry</Button>
          <Button onClick={onClose}>Close window</Button>
        </div>
      </div>
    </div>
  )
}
