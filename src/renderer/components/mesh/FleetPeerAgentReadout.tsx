import { memo, useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import type { RemotePeerAgent } from '../../../shared/types/ipc.types'

/**
 * Full agent-card readout for a remote agent on a peer runtime — the
 * click-to-pin big sibling of the FleetPeerAgentCard hover teaser. Same
 * presentation family as the group readout: backdrop blur, centered card,
 * Esc or click-away to close. Renders EVERYTHING the signed card delivers:
 * untruncated status/description, shared files (click to read them right
 * here — markdown rendered, code in mono — with a download button), the
 * named endpoint map, and the served routes collapsed at the bottom.
 */

interface FileView {
  path: string
  loading: boolean
  error?: string
  content?: string
  binary?: boolean
  size?: number
}

/** Peer file content is untrusted — strip raw HTML before markdown parse. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const isMarkdownPath = (p: string): boolean => /\.(md|markdown)$/i.test(p)

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">{title}</div>
      {children}
    </div>
  )
}

function Pill({ tone, children }: { tone: 'green' | 'sky' | 'violet' | 'amber' | 'neutral'; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400',
    sky: 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400',
    violet: 'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400',
    amber: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
    neutral: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400'
  }
  return <span className={`text-[10px] px-2 py-0.5 rounded-full ${tones[tone]}`}>{children}</span>
}

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
  const [showRoutes, setShowRoutes] = useState(false)
  const [fileView, setFileView] = useState<FileView | null>(null)

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

  // The agent's base URL comes off its own card endpoint; shared files are
  // served at <base>/<path>. No card endpoint → files listed but not readable.
  const cardUrl = agent.endpoints?.card
  const openFile = (path: string): void => {
    if (!cardUrl) return
    setFileView({ path, loading: true })
    window.adfApi.getPeerSharedFile(cardUrl, path).then((res) => {
      setFileView((cur) => {
        if (!cur || cur.path !== path) return cur
        return res.ok
          ? { path, loading: false, content: res.content, binary: res.binary, size: res.size }
          : { path, loading: false, error: res.error }
      })
    }).catch(() => {
      setFileView((cur) => (cur?.path === path ? { path, loading: false, error: 'Fetch failed' } : cur))
    })
  }

  const downloadFile = (): void => {
    if (!fileView?.content) return
    const bytes = fileView.binary
      ? Uint8Array.from(atob(fileView.content), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(fileView.content)
    const blob = new Blob([bytes])
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = fileView.path.split('/').pop() ?? 'file'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const fileHtml = useMemo(() => {
    if (!fileView?.content || fileView.binary || !isMarkdownPath(fileView.path)) return null
    return marked.parse(escapeHtml(fileView.content)) as string
  }, [fileView])

  const endpointRows = Object.entries(agent.endpoints ?? {}).filter(
    (e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0
  )
  const signingRequired = (agent.policies ?? []).some(
    (p) => p.type === 'signing' && (p.receive === 'required' || p.send === 'required')
  )
  const shared = agent.shared ?? []
  const routes = agent.mesh_routes ?? []
  const signedAt = agent.signed_at ? new Date(agent.signed_at) : null

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] max-h-[82vh] flex flex-col rounded-2xl bg-white/95 dark:bg-neutral-900/95 border border-neutral-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Identity header — stays put in both card and file view */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <span className="text-3xl leading-none shrink-0">{agent.icon || '🤖'}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
              {agent.handle}
              {fileView && (
                <span className="font-normal text-neutral-400 dark:text-neutral-500"> / {fileView.path}</span>
              )}
            </div>
            <div className="text-[11px] text-neutral-400 dark:text-neutral-500">
              remote agent · {peerHost}
            </div>
          </div>
          {fileView && fileView.content && (
            <button
              onClick={downloadFile}
              className="shrink-0 px-2.5 py-1 text-[11px] rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              ↓ download
            </button>
          )}
          {fileView && (
            <button
              onClick={() => setFileView(null)}
              className="shrink-0 px-2.5 py-1 text-[11px] rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              ← card
            </button>
          )}
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* ---- File view ---- */}
        {fileView ? (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
            {fileView.loading && (
              <div className="py-8 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
                fetching from {peerHost}…
              </div>
            )}
            {fileView.error && (
              <div className="py-8 text-center text-[12px] text-red-500">{fileView.error}</div>
            )}
            {fileView.content && fileView.binary && (
              <div className="py-8 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
                Binary file · {Math.round((fileView.size ?? 0) / 1024)} KB — use download.
              </div>
            )}
            {fileHtml && (
              <div
                className="loop-markdown text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-200"
                dangerouslySetInnerHTML={{ __html: fileHtml }}
              />
            )}
            {fileView.content && !fileView.binary && !fileHtml && (
              <pre className="font-mono text-[11px] leading-[1.6] text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap break-words">
                {fileView.content}
              </pre>
            )}
          </div>
        ) : (
          <>
            {/* ---- Card view ---- */}
            {/* Trust + reach */}
            <div className="flex items-center gap-1.5 px-5 pb-3 flex-wrap">
              {agent.card_verified ? <Pill tone="green">✓ signed card</Pill> : <Pill tone="neutral">unverified</Pill>}
              {agent.owner_attested && <Pill tone="sky">owner attested</Pill>}
              {signingRequired && <Pill tone="violet">signing required</Pill>}
              {agent.public && <Pill tone="amber">public</Pill>}
              {agent.visibility && (
                <Pill tone="neutral">{agent.visibility === 'lan' ? 'LAN' : agent.visibility}</Pill>
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
                <Section title="about">
                  <div className="text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap">
                    {agent.description}
                  </div>
                </Section>
              )}

              {/* Shared files — click to read right here */}
              {shared.length > 0 && (
                <Section title={`shared files · ${shared.length}`}>
                  <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60 px-1 py-1 max-h-56 overflow-y-auto">
                    {shared.map((f) => (
                      <button
                        key={f}
                        onClick={() => openFile(f)}
                        disabled={!cardUrl}
                        className="w-full text-left px-1.5 py-0.5 rounded font-mono text-[11px] leading-[1.6] text-neutral-600 dark:text-neutral-300 truncate hover:bg-neutral-100 dark:hover:bg-neutral-700/60 hover:text-blue-600 dark:hover:text-blue-400 disabled:hover:bg-transparent"
                        title={cardUrl ? `Read ${f}` : f}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </Section>
              )}

              {/* Endpoints — the card's named map */}
              {endpointRows.length > 0 && (
                <Section title="endpoints">
                  <div className="space-y-1">
                    {endpointRows.map(([name, url]) => (
                      <div
                        key={name}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60"
                      >
                        <span className="text-[10px] w-11 shrink-0 text-center px-1 py-px rounded bg-neutral-200/70 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400">
                          {name}
                        </span>
                        <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300 truncate" title={url}>
                          {url}
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* DID — full, copyable; provenance below */}
              {agent.did && (
                <Section title="did">
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
                  {(agent.attested_owner_did || signedAt) && (
                    <div className="mt-1.5 space-y-0.5">
                      {agent.attested_owner_did && (
                        <div className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate" title={agent.attested_owner_did}>
                          owner: <span className="font-mono">{agent.attested_owner_did}</span>
                        </div>
                      )}
                      {signedAt && !isNaN(signedAt.getTime()) && (
                        <div className="text-[10px] text-neutral-400 dark:text-neutral-500">
                          card signed {signedAt.toLocaleString()}
                        </div>
                      )}
                    </div>
                  )}
                </Section>
              )}

              {/* Served routes — collapsed footnote; the API surface matters
                  less than what the agent says and shares */}
              {routes.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowRoutes((v) => !v)}
                    className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    {showRoutes ? '▾' : '▸'} serves · {routes.length} route{routes.length === 1 ? '' : 's'}
                  </button>
                  {showRoutes && (
                    <div className="mt-1 space-y-1">
                      {routes.map((r, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60"
                        >
                          <span className="text-[10px] font-semibold w-11 shrink-0 text-center px-1 py-px rounded bg-neutral-200/70 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-300">
                            {r.method}
                          </span>
                          <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300 truncate">{r.path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
})
