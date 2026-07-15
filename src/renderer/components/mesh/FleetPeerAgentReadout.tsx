import { memo, useEffect, useState } from 'react'
import type { RemotePeerAgent } from '../../../shared/types/ipc.types'

/**
 * Full agent-card readout for a remote agent on a peer runtime — the
 * click-to-pin big sibling of the FleetPeerAgentCard hover teaser. Same
 * presentation family as the group readout: backdrop blur, centered card,
 * Esc or click-away to close. Shows the card in full: untruncated status
 * and description, every endpoint, and the complete DID (copyable).
 */
export const FleetPeerAgentReadout = memo(function FleetPeerAgentReadout({
  agent,
  peerHost,
  onClose
}: {
  agent: RemotePeerAgent
  peerHost: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const copyDid = (): void => {
    if (!agent.did) return
    navigator.clipboard.writeText(agent.did).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* clipboard unavailable */ })
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[90vw] max-h-[80vh] flex flex-col rounded-2xl bg-white/95 dark:bg-neutral-900/95 border border-neutral-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Identity header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <span className="text-3xl leading-none shrink-0">🤖</span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
              {agent.handle}
            </div>
            <div className="text-[11px] text-neutral-400 dark:text-neutral-500">
              remote agent · {peerHost}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Trust + reach */}
        <div className="flex items-center gap-1.5 px-5 pb-3 flex-wrap">
          {agent.card_verified ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400">
              ✓ signed card
            </span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500">
              unverified
            </span>
          )}
          {agent.owner_attested && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400">
              owner attested
            </span>
          )}
          {agent.visibility && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
              {agent.visibility === 'lan' ? 'LAN' : agent.visibility}
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-3">
          {/* Live status — untruncated */}
          {agent.status && (
            <div className="px-4 py-3 rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60">
              <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">status</div>
              <div className="text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap">
                {agent.status}
              </div>
            </div>
          )}

          {/* Description — the agent's own words, in full */}
          {agent.description && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">about</div>
              <div className="text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap">
                {agent.description}
              </div>
            </div>
          )}

          {/* Endpoints */}
          {agent.endpoints && agent.endpoints.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">
                endpoints
              </div>
              <div className="space-y-1">
                {agent.endpoints.map((ep, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60"
                  >
                    {ep.protocol && (
                      <span className="text-[10px] px-1.5 py-px rounded bg-neutral-200/70 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 shrink-0">
                        {ep.protocol}
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300 truncate" title={ep.url}>
                      {ep.url ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* DID — full, copyable */}
          {agent.did && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">did</div>
              <button
                onClick={copyDid}
                className="w-full text-left px-2.5 py-1.5 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60 hover:border-neutral-300 dark:hover:border-neutral-600"
                title="Click to copy"
              >
                <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400 break-all">
                  {agent.did}
                </span>
                <span className="ml-2 text-[10px] text-blue-500">{copied ? 'copied ✓' : 'copy'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
