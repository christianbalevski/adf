import { useState } from 'react'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'
import { useMcpRegistryStore } from '../../stores/mcp-registry.store'
import { Dialog } from '../common/Dialog'
import { HOST_ACCESS_CONFIRM, useConfirm } from '../common/ConfirmDialog'
import { Button } from '../ui'
import { useSettingsApi } from '../settings/settings-runtime'
import { McpAddServerModal, registrationSourceLine, registryEntryFor } from './McpAddServerModal'
import { BrandIcon } from './BrandIcon'
import { PickerGrid, PickerTile } from '../common/PickerTile'
import { ComputeNeededSheet } from './ComputeNeededSheet'
import { addRuntimeMcpServer } from './runtime-mcp-servers'
import { writeSettings } from '../settings/settings-save'
import { invalidateConfigCaches } from '../../utils/config-caches'

interface AgentMcpAddDialogProps {
  onClose: () => void
  /** Every server registered in the agent's runtime. */
  registrations: McpServerRegistration[]
  /** Servers already on the agent. */
  attachedNames: Set<string>
  hostAccessEnabled: boolean
  mcpOnHost: boolean
  /** Put a runtime server on the agent. */
  onAttach: (reg: McpServerRegistration) => void
  /** The runtime's settings were written here (a new server, compute switches): read them again. */
  onRuntimeChanged: () => void
  onError: (message: string) => void
}

/**
 * Add an MCP server to an agent: one already in its runtime, or a new one,
 * set up with the same dialog as Settings → MCP, then registered in the
 * runtime and put on the agent.
 */
export function AgentMcpAddDialog({ onClose, registrations, attachedNames, hostAccessEnabled, mcpOnHost, onAttach, onRuntimeChanged, onError }: AgentMcpAddDialogProps) {
  const api = useSettingsApi()
  const bundledServers = useMcpRegistryStore((s) => s.bundledServers)
  const registryEntries = useMcpRegistryStore((s) => s.entries)
  const [confirmDialog, confirm] = useConfirm()
  const [creating, setCreating] = useState(false)
  const [computeSheet, setComputeSheet] = useState<{ name: string; pinnedToContainer?: boolean; retry: () => void; runOnHost: () => Promise<boolean> } | null>(null)
  const available = registrations.filter((r) => r.name && !attachedNames.has(r.name))

  /** Runtime compute switches (`settings.compute` merges a partial object). */
  const writeCompute = async (patch: { hostAccessEnabled?: boolean; mcpOnHost?: boolean }): Promise<boolean> => {
    const outcome = await writeSettings({ compute: patch }, api)
    if (!outcome.ok) { onError(outcome.error); return false }
    invalidateConfigCaches()
    onRuntimeChanged()
    return true
  }

  const saveNew = (reg: McpServerRegistration) => {
    void addRuntimeMcpServer(api, reg, bundledServers)
      .then(() => { onRuntimeChanged(); onAttach(reg) })
      .catch((err: unknown) => onError(`${reg.name} was not added: ${err instanceof Error ? err.message : String(err)}`))
  }

  return (
    <>
      {confirmDialog}
      {/* Unmounted, not closed, while the new-server dialog shows: closing a
          Dialog fires its onClose, which would end the whole flow. */}
      {!creating && <Dialog open onClose={onClose} title="Add MCP server" wide>
        <div className="space-y-3">
          {available.length > 0 ? (
            <PickerGrid>
              {available.map((reg) => {
                const entry = registryEntryFor(reg, registryEntries)
                return (
                  <PickerTile
                    key={reg.id}
                    icon={<BrandIcon iconKey={entry?.iconKey} category={entry?.category ?? (reg.type === 'http' ? 'web' : 'tools')} size={28} />}
                    title={reg.name}
                    detail={registrationSourceLine(reg, bundledServers, hostAccessEnabled, mcpOnHost)}
                    onClick={() => { onAttach(reg); onClose() }}
                  />
                )
              })}
            </PickerGrid>
          ) : (
            <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
              {registrations.length === 0 ? 'No servers in this runtime yet.' : 'Every server in this runtime is on this agent.'}
            </p>
          )}
          <div className="flex justify-end border-t border-[var(--adf-ui-separator)] pt-3">
            <Button variant="secondary" size="compact" onClick={() => setCreating(true)}>+ Add a new server</Button>
          </div>
        </div>
      </Dialog>}

      <McpAddServerModal
        open={creating}
        onClose={onClose}
        editing={null}
        existingServers={[...registrations, ...[...attachedNames].map((name) => ({ name }))]}
        hostAccessEnabled={hostAccessEnabled}
        mcpOnHost={mcpOnHost}
        onEnableHostAccess={() => { void confirm(HOST_ACCESS_CONFIRM).then((yes) => { if (yes) void writeCompute({ hostAccessEnabled: true }) }) }}
        onEnableHostAccessNow={() => writeCompute({ hostAccessEnabled: true })}
        onComputeNeeded={(name, actions) => setComputeSheet({ name, pinnedToContainer: actions.pinnedToContainer, retry: actions.retry, runOnHost: actions.runOnHost })}
        onSave={saveNew}
      />

      <ComputeNeededSheet
        open={!!computeSheet}
        servers={computeSheet ? [computeSheet.name] : []}
        api={api}
        onClose={() => setComputeSheet(null)}
        onResolved={() => {
          const sheet = computeSheet
          setComputeSheet(null)
          sheet?.retry()
        }}
        runOnHost={computeSheet?.runOnHost}
        acceptMcpOnHost={(mcpOnHost && hostAccessEnabled) || computeSheet?.pinnedToContainer ? undefined : () => writeCompute({ hostAccessEnabled: true, mcpOnHost: true })}
      />
    </>
  )
}
