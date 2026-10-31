/**
 * An MCP server can't start because the compute environment (Podman) isn't
 * set up: its status is `needs_compute`. Shown at that moment, from the
 * agent (an mcp_install or a start) and from Settings → MCP (Connect). Three
 * ways forward, safest first:
 *
 * - Set up Podman: runs the same steps as Settings → Compute's wizard.
 * - Run these servers on this computer: a per-server host grant, confirmed.
 * - Run every MCP server on this computer: settings.compute.mcpOnHost, after
 *   an explicit acceptance (MCP_ON_HOST_CONFIRM).
 *
 * The caller does the writes (they differ per scope) and reconnects in
 * `onResolved`. Nothing here falls back to the host without a choice.
 */
import { useCallback, useEffect, useState } from 'react'
import { Dialog } from '../common/Dialog'
import { HOST_ACCESS_CONFIRM, MCP_ON_HOST_CONFIRM, useConfirm } from '../common/ConfirmDialog'
import { Button } from '../ui'
import type { ComputeSetupResult } from '../../../shared/types/compute.types'
import { computeSetupPlan, type ComputeSetupPlan } from './compute-setup-plan'

export interface ComputeSetupApi {
  computeSetup?: (args: { step: 'install' | 'machine_init' | 'machine_start' | 'check'; installCommand?: string }) => Promise<ComputeSetupResult>
}

export interface ComputeNeededSheetProps {
  open: boolean
  /** The servers waiting on compute. */
  servers: string[]
  api: ComputeSetupApi | null | undefined
  onClose: () => void
  /** Podman is ready, or a host choice was saved: reconnect the servers. */
  onResolved: () => void
  /** Save "these servers run on this computer". Resolves false when not saved. Absent: not offered. */
  runOnHost?: () => Promise<boolean>
  /** Save settings.compute.mcpOnHost (and Host access). Resolves false when not saved. Absent: not offered. */
  acceptMcpOnHost?: () => Promise<boolean>
  /** The runtime is another machine (a remote daemon): say so instead of "this computer". */
  remote?: boolean
}

/** At most this many steps per click: install, machine init, machine start, and slack. */
const MAX_STEPS = 5

export function ComputeNeededSheet({ open, servers, api, onClose, onResolved, runOnHost, acceptMcpOnHost, remote }: ComputeNeededSheetProps) {
  const [plan, setPlan] = useState<ComputeSetupPlan | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDialog, confirm] = useConfirm()

  const check = useCallback(async (): Promise<ComputeSetupPlan | null> => {
    const r = await api?.computeSetup?.({ step: 'check' })
    const next = r?.availability ? computeSetupPlan(r.availability) : null
    setPlan(next)
    return next
  }, [api])

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(null)
    setPlan(null)
    void check().catch((err) => setError(String(err)))
  }, [open, check])

  const setUp = async () => {
    setError(null)
    try {
      let current = plan ?? await check()
      for (let i = 0; i < MAX_STEPS && current?.kind === 'step'; i++) {
        const { next } = current
        setBusy(`${next.label}…`)
        const r = await api?.computeSetup?.(next.step === 'install' ? { step: 'install', installCommand: next.installCommand } : { step: next.step })
        if (!r?.success) {
          setError(r?.error ?? `${next.label} failed.`)
          await check()
          return
        }
        current = r.availability ? computeSetupPlan(r.availability) : await check()
        setPlan(current)
      }
      if (current?.kind === 'ready') onResolved()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const named = servers.length === 1 ? `"${servers[0]}"` : 'These MCP servers'
  const place = remote ? 'the computer running this agent' : 'this computer'
  const hostOne = async () => {
    if (!runOnHost) return
    const yes = await confirm({
      title: servers.length === 1 ? `Run ${servers[0]} on the host` : 'Run these servers on the host',
      body: (
        <>
          <p>{named} will run directly on {place} instead of in a container, with its files and network. Servers set up in Settings → MCP servers run on the host for every agent that uses them.</p>
          <p className="mt-2">This turns on Host access if it is off. {HOST_ACCESS_CONFIRM.body}</p>
        </>
      ),
      confirmLabel: 'Run on the host',
      danger: true,
    })
    if (!yes) return
    setBusy('Saving…')
    try {
      if (await runOnHost()) onResolved()
      else setError('Not saved.')
    } finally {
      setBusy(null)
    }
  }
  const hostAll = async () => {
    if (!acceptMcpOnHost || !await confirm(MCP_ON_HOST_CONFIRM)) return
    setBusy('Saving…')
    try {
      if (await acceptMcpOnHost()) onResolved()
      else setError('Not saved.')
    } finally {
      setBusy(null)
    }
  }

  // The confirm renders beside the sheet, not inside it: a nested <dialog>'s
  // close event would bubble to the sheet's onClose and close it too.
  return (
    <>
    <Dialog open={open} onClose={onClose} title="Set up a container for MCP servers" preventClose={!!busy}>
      <div className="space-y-4 text-[13px] leading-5">
        <p className="text-[var(--adf-ui-text-muted)]">
          {named} {servers.length === 1 ? 'needs' : 'need'} Podman to run in a container, away from your files. Podman isn&apos;t set up on {place} yet.
        </p>

        <div className="space-y-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-3 py-2.5">
          {plan === null && !error && <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">Checking Podman…</p>}
          {plan?.kind === 'manual' && (
            <>
              <p className="text-[12px] text-[var(--adf-ui-text)]">{plan.reason}</p>
              <div className="flex gap-1.5">
                {plan.url && <Button variant="primary" className="flex-1" onClick={() => window.open(plan.url, '_blank', 'noopener,noreferrer')}>Download Podman</Button>}
                <Button variant="secondary" onClick={() => void check()} disabled={!!busy}>Check again</Button>
              </div>
            </>
          )}
          {(plan?.kind === 'step' || plan?.kind === 'ready') && (
            <Button variant="primary" className="w-full" onClick={() => void (plan.kind === 'ready' ? onResolved() : setUp())} disabled={!!busy} loading={!!busy && busy !== 'Saving…'}>
              {busy && busy !== 'Saving…' ? busy : plan.kind === 'ready' ? 'Connect' : 'Set up Podman (recommended)'}
            </Button>
          )}
          {busy && busy !== 'Saving…' && <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">This can take a few minutes.{remote ? '' : ' Your system may ask for your password.'}</p>}
          {error && <p className="text-[11px] text-[var(--adf-ui-danger)] break-words" role="alert">{error}</p>}
        </div>

        {(runOnHost || acceptMcpOnHost) && (
          <div className="space-y-1.5">
            <p className="text-[12px] text-[var(--adf-ui-text-muted)]">Or skip the container. Servers on the host can read and change the files on {place}.</p>
            <div className="flex flex-wrap gap-1.5">
              {runOnHost && (
                <Button variant="secondary" onClick={() => void hostOne()} disabled={!!busy}>
                  {servers.length === 1 ? `Run ${servers[0]} on the host…` : 'Run these on the host…'}
                </Button>
              )}
              {acceptMcpOnHost && (
                <Button variant="ghost" onClick={() => void hostAll()} disabled={!!busy}>Run all MCP servers on the host…</Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
    {confirmDialog}
    </>
  )
}
