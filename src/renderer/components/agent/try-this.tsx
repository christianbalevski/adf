import type { AgentConfig } from '../../../shared/types/adf-v02.types'

/**
 * One first message for an existing agent, picked from what it can reach.
 * Keyed on the attached MCP server's npm package, not its name, because
 * users rename servers. The first matching server in config order wins.
 * Every line asks the agent to read, not to change anything.
 */
const BY_NPM_PACKAGE: ReadonlyMap<string, string> = new Map([
  ['@gongrzhe/server-gmail-autoauth-mcp', "Show me the senders and subjects of my latest emails. Don't change anything."],
  ['@cocal/google-calendar-mcp', "What's on my calendar for the next 7 days? Don't change anything."],
])

export const TRY_THIS_FALLBACK = "Tell me what you can do with what you can reach right now, and give me one thing to try. Don't change anything."

export function tryThisPrompt(config: Pick<AgentConfig, 'mcp'> | null | undefined): string {
  for (const server of config?.mcp?.servers ?? []) {
    const line = BY_NPM_PACKAGE.get(server.npm_package ?? '')
    if (line) return line
  }
  return TRY_THIS_FALLBACK
}

/**
 * The "Try this" chip above an agent's composer: main loop only, and only
 * while the box is empty, so it never overwrites a draft. Clicking hands the
 * line to `onPick` (fill and focus); it is a plain button and never submits.
 * Colours and border as the Home suggestion chips; the label sits on its own
 * line so the chip gets the full width and wraps to show the whole line.
 */
export function TryThisChip({ isMainLoop, draft, disabled, config, onPick }: {
  isMainLoop: boolean
  draft: string
  disabled: boolean
  config: Pick<AgentConfig, 'mcp'> | null | undefined
  onPick: (line: string) => void
}) {
  if (!isMainLoop || draft.length > 0 || disabled) return null
  const line = tryThisPrompt(config)
  return (
    <div className="mb-2 px-1">
      <div className="mb-1 text-[12px] font-medium text-[var(--adf-ui-text-muted)]">Try this</div>
      <button
        type="button"
        onClick={() => onPick(line)}
        className="block max-w-full whitespace-normal break-words rounded-[var(--radius-lg)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] px-3 py-1.5 text-left text-[12px] leading-snug text-[var(--adf-ui-text-muted)] transition-colors hover:border-[var(--adf-ui-accent)] hover:text-[var(--adf-ui-text)]"
      >
        {line}
      </button>
    </div>
  )
}
