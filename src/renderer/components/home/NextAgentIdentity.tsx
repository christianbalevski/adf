import { useCallback, useEffect, useRef, useState } from 'react'
import type { IdentityDraft } from '../../../shared/types/ipc.types'
import { LiveOrbital } from '../orbital'
import { Tooltip } from '../common/Tooltip'

const DID_HEAD = 'did:key:z6Mk'.length

/** did:key:z6Mk…ab12 */
export function shortDid(did: string): string {
  return did.length > DID_HEAD + 8 ? `${did.slice(0, DID_HEAD)}…${did.slice(-4)}` : did
}

function discard(d: IdentityDraft | null): void {
  if (d) window.adfApi.discardIdentityDraft(d.draftId).catch(() => {})
}

/**
 * The next agent's identity, minted in main before the agent exists. The
 * private key never leaves main; this holds only { draftId, did }. `renew`
 * drops the current draft and mints another (the reroll, and after a send,
 * whose create consumed it). The draft is dropped on unmount. Mints that
 * land after a newer renew, or after unmount, are discarded on arrival.
 */
export function useIdentityDraft(): { draft: IdentityDraft | null; renew: () => void; current: () => IdentityDraft | null } {
  const [draft, setDraft] = useState<IdentityDraft | null>(null)
  const held = useRef<IdentityDraft | null>(null)
  const seq = useRef(0)
  const alive = useRef(false)

  const renew = useCallback(() => {
    const mine = ++seq.current
    discard(held.current)
    held.current = null
    window.adfApi.mintIdentityDraft().then(
      (next) => {
        if (!alive.current || mine !== seq.current) { discard(next); return }
        held.current = next
        setDraft(next)
      },
      (err) => {
        console.warn('[home] Could not mint an identity draft:', err)
        if (alive.current && mine === seq.current) setDraft(null)
      }
    )
  }, [])

  useEffect(() => {
    alive.current = true
    renew()
    return () => {
      alive.current = false
      seq.current++
      discard(held.current)
      held.current = null
    }
  }, [renew])

  const current = useCallback(() => held.current, [])
  return { draft, renew, current }
}

/**
 * The next agent's orbital, seeded by its real DID. Typing in the name turns
 * it (spinImpulse); the DID alone decides the shape, so the only way to a
 * different shape is a new identity.
 */
export function NextAgentIdentity({ did, spinImpulse, onReroll, disabled }: {
  did: string | null
  spinImpulse: number
  onReroll: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex w-[104px] shrink-0 flex-col items-center gap-1">
      <LiveOrbital seed={did} size={96} spinImpulse={spinImpulse} />
      <div className="flex max-w-full items-center gap-0.5">
        {did ? (
          <Tooltip tip={did} className="min-w-0">
            <span title={did} className="block truncate font-mono text-[10px] text-[var(--adf-ui-text-subtle)]">
              {shortDid(did)}
            </span>
          </Tooltip>
        ) : (
          <span className="font-mono text-[10px] text-[var(--adf-ui-text-subtle)]">&nbsp;</span>
        )}
        <Tooltip tip="New identity" className="shrink-0">
          <button
            type="button"
            onClick={onReroll}
            disabled={disabled}
            aria-label="New identity"
            className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--adf-ui-text-muted)] transition-colors hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] disabled:opacity-40"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 4v6h6M21 20v-6h-6" />
              <path d="M21 10A9 9 0 0 0 5.6 6.3L3 10M3 14a9 9 0 0 0 15.4 3.7L21 14" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
