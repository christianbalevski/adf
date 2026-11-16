import { useEffect, useState } from 'react'
import { useSettingsApi } from './settings-runtime'

/** Count each saved source when its row mounts, without downloading manifests. */
export function SkillSourceCount({ url }: { url: string }) {
  const api = useSettingsApi()
  const [result, setResult] = useState<{ count: number } | { error: string } | null>(null)

  useEffect(() => {
    let active = true
    setResult(null)
    void (async () => {
      try {
        const source = await api?.getSkillsCatalog(url)
        if (!active) return
        setResult(source?.ok
          ? { count: source.discovered?.packages.length ?? source.entries.length }
          : { error: source?.error ?? 'Could not read source' })
      } catch (err) {
        if (active) setResult({ error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => { active = false }
  }, [api, url])

  return (
    <span
      className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]"
      title={result && 'error' in result ? result.error : undefined}
      aria-live="polite"
    >
      {result === null ? 'Loading…' : 'error' in result ? 'Unavailable' : `${result.count} skill${result.count === 1 ? '' : 's'}`}
    </span>
  )
}
