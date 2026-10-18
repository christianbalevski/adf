import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import type { NetworkNotice } from '../../../shared/types/remote-access-ipc.types'

/**
 * "Remote access paused on <network>." as a strip in the window, never a
 * dialog (docs/design/remote-access.md §3.3.1, consent review 3). Studio
 * main shows one per network per session; Allow on this network, Not now,
 * or leaving the network takes it away. Settings → Networking's status line
 * shows the same state.
 */
export function NetworkNoticeBanner() {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const [notices, setNotices] = useState<NetworkNotice[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.adfApi?.getNetworkNotices?.().then((n) => { if (alive) setNotices(n) }).catch(() => {})
    const off = window.adfApi?.onNetworkNoticesChanged?.((n) => setNotices(n))
    return () => { alive = false; off?.() }
  }, [])

  const allow = async (notice: NetworkNotice) => {
    if (!notice.networkId) return
    setBusy(notice.key)
    setError(null)
    try {
      const result = await window.adfApi.allowNetwork(notice.networkId)
      if (!result.ok) setError(result.error)
    } catch {
      setError('Studio could not allow this network.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <NetworkNoticeList
      notices={notices}
      busy={busy}
      error={error}
      onAllow={(n) => void allow(n)}
      onDismiss={(n) => { void window.adfApi?.dismissNetworkNotice?.(n.key) }}
      onOpenNetworking={() => openSettingsAt('networking')}
    />
  )
}

export function NetworkNoticeList({ notices, busy, error, onAllow, onDismiss, onOpenNetworking }: {
  notices: NetworkNotice[]
  busy: string | null
  error: string | null
  onAllow: (notice: NetworkNotice) => void
  onDismiss: (notice: NetworkNotice) => void
  onOpenNetworking: () => void
}) {
  if (notices.length === 0) return null
  return (
    <div role="status" aria-live="polite" className="w-full shrink-0">
      {notices.map((n) => (
        <div key={n.key} className="w-full flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] text-[11px] text-[var(--adf-ui-warning)]">
          <span>{n.message}</span>
          {n.canAllow && (
            <button type="button" disabled={busy === n.key} onClick={() => onAllow(n)} className="font-medium underline cursor-pointer disabled:opacity-60">
              Allow on this network
            </button>
          )}
          {!n.canAllow && (
            <button type="button" onClick={onOpenNetworking} className="underline cursor-pointer">Open Networking</button>
          )}
          <button type="button" onClick={() => onDismiss(n)} className="underline cursor-pointer">Not now</button>
          {n.warning && <span className="w-full text-center">{n.warning}</span>}
          {error && busy === null && <span className="w-full text-center text-[var(--adf-ui-danger)]">{error}</span>}
        </div>
      ))}
    </div>
  )
}
