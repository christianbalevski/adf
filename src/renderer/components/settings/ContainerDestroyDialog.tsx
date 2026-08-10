import { Dialog } from '../common/Dialog'
import { Button } from '../ui'
import type { ContainerSummary } from '../../../shared/types/compute.types'

export type ContainerDestroyAction = 'rebuild' | 'remove'

export interface ContainerDestroyRequest {
  container: ContainerSummary
  action: ContainerDestroyAction
  /** Agents interrupted by destroying the shared container. */
  activeAgents: string[]
  isShared: boolean
}

/**
 * Confirmation for the two container actions that run `podman rm -f`. Both
 * delete the writable layer — /workspace is an in-container directory, not a
 * mount — so the dialog spells out what is lost rather than saying "state".
 */
export function ContainerDestroyDialog({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: ContainerDestroyRequest | null
  busy: boolean
  onCancel: () => void
  onConfirm: (request: ContainerDestroyRequest) => void
}) {
  if (!request) return null
  const { container, action, activeAgents, isShared } = request
  const rebuilding = action === 'rebuild'
  const owner = container.agentName || container.agentId

  return (
    // Esc dismisses even mid-run: the podman call cannot be aborted, so holding
    // the dialog open would only trap the user. The row stays busy and the
    // outcome still lands in the status line.
    <Dialog
      open
      onClose={onCancel}
      title={rebuilding ? `Rebuild ${container.name}?` : `Remove ${container.name}?`}
    >
      <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
        {rebuilding
          ? 'The container is deleted and recreated from the configured base image. Everything inside it is permanently lost:'
          : 'The container is permanently deleted. Everything inside it is lost:'}
      </p>

      <ul className="mt-3 space-y-1.5 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-danger-subtle)] p-3 text-[11px] text-[var(--adf-ui-text)]">
        <li>
          <span className="font-medium">Workspace files</span> — everything under{' '}
          <code className="font-mono text-[10px]">/workspace</code>
          {owner ? <> for {owner}</> : null}. It is a directory inside the container, not a folder on this machine, so nothing is recoverable.
        </li>
        <li><span className="font-medium">Installed packages</span> — apt, pip, and npm installs made since the container was created.</li>
        <li><span className="font-medium">Running processes</span> — anything the agent left running, including browser sessions.</li>
      </ul>

      <p className="mt-3 text-[11px] text-[var(--adf-ui-text-muted)]">
        {rebuilding
          ? isShared
            ? 'A fresh container is created immediately.'
            : 'A fresh container is created the next time the agent starts.'
          : 'A fresh container is created the next time the agent starts.'}{' '}
        The agent definition, its identity, and the shared npm cache are not affected.
      </p>

      {activeAgents.length > 0 && (
        <p className="mt-3 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[11px] text-[var(--adf-ui-warning)]">
          {activeAgents.length} active agent{activeAgents.length === 1 ? '' : 's'} use this container and will be interrupted mid-run.
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="danger" loading={busy} onClick={() => onConfirm(request)}>
          {rebuilding ? 'Delete and rebuild' : 'Delete permanently'}
        </Button>
      </div>
    </Dialog>
  )
}
