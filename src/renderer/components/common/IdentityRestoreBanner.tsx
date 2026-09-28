import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app.store'

/**
 * Strip below the title bar when this machine's owner DID is seed-derived but
 * Studio cannot read its phrase (set up in the ADF terminal with a
 * passphrase-protected file). Studio never mints a replacement owner in that
 * case; this says so and opens Settings → Identity to restore it.
 */
export function IdentityRestoreBanner() {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const [ownerDid, setOwnerDid] = useState<string | null>(null)

  useEffect(() => {
    const check = () => {
      window.adfApi?.getOwnerIdentityStatus?.()
        .then((status) => setOwnerDid(status?.restoreRequired ? status.ownerDid : null))
        .catch(() => setOwnerDid(null))
    }
    check()
    // Restored in Settings, or in the terminal on this machine: re-check on return.
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  if (!ownerDid) return null
  const short = ownerDid.length > 24 ? `${ownerDid.slice(0, 14)}…${ownerDid.slice(-4)}` : ownerDid
  return (
    <div role="status" className="w-full shrink-0">
      <button
        type="button"
        onClick={() => openSettingsAt('identity', 'restore-identity')}
        className="w-full flex items-center justify-center gap-2 px-3 py-1.5 border-b border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] text-[11px] text-[var(--adf-ui-warning)] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]"
      >
        <span>Your owner identity <span className="font-mono">{short}</span> was set up in the terminal. Enter its 12 words to use it in Studio.</span>
        <span className="font-medium underline">Restore your identity</span>
      </button>
    </div>
  )
}
