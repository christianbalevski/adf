/** Custom HTTP servers can opt into the same OAuth flow as curated entries. */
export function McpHttpOAuthToggle({ enabled, onChange }: {
  enabled: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <label className="flex items-start justify-between gap-3 text-xs text-neutral-700 dark:text-neutral-300">
      <span>
        Browser sign-in (OAuth)
        <span className="block text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">
          Use for servers that support MCP OAuth. Connect opens the provider’s sign-in page when authorization is needed.
        </span>
      </span>
      <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
    </label>
  )
}
