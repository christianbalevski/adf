import { InfoHint } from '../common/DocsLink'

/** Custom HTTP servers can opt into the same OAuth flow as curated entries. */
export function McpHttpOAuthToggle({ enabled, onChange }: {
  enabled: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-neutral-700 dark:text-neutral-300">
      <span className="inline-flex items-center">
        Browser sign-in (OAuth)
        <InfoHint tip="For servers that support MCP OAuth. Connect opens the provider’s sign-in page when authorization is needed." />
      </span>
      <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}
