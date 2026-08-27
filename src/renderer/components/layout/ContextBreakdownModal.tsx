import { useCallback, useEffect, useState } from 'react'
import { Dialog } from '../common/Dialog'
import { Tooltip } from '../common/Tooltip'
import { Button } from '../ui'
import { useAgentStore } from '../../stores/agent.store'
import type { ContextBreakdown, ContextBreakdownToolGroup } from '../../../shared/types/ipc.types'

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** `$0.0042`-style: 4 decimals below $1, 2 above (cents resolution is enough there). */
export function formatUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

/** Cycled through for per-{{file}} bar segments — blue-family shades so they
 *  read as subdivisions of the system prompt, distinct from the other parts. */
const FILE_COLORS = ['bg-cyan-400', 'bg-blue-400', 'bg-indigo-400', 'bg-sky-300']

interface BarSegment {
  key: string
  label: string
  color: string
  tokens: number
}

function Row({
  label,
  tokens,
  indent,
  bold,
  onClick,
  expanded
}: {
  label: string
  tokens: number
  indent?: boolean
  bold?: boolean
  /** Present on expandable group rows — toggles the per-tool sub-rows. */
  onClick?: () => void
  expanded?: boolean
}) {
  const inner = (
    <>
      <span className={`truncate ${bold ? 'font-semibold text-[var(--adf-ui-text)]' : indent ? 'text-[var(--adf-ui-text-subtle)]' : 'text-[var(--adf-ui-text-muted)]'}`}>
        {onClick && (
          <span className="mr-1 inline-block w-2 text-[var(--adf-ui-text-subtle)]">{expanded ? '▾' : '▸'}</span>
        )}
        {label}
      </span>
      <span className={`ml-auto shrink-0 pl-3 font-mono tabular-nums ${bold ? 'font-semibold text-[var(--adf-ui-text)]' : 'text-[var(--adf-ui-text-subtle)]'}`}>
        {formatTokens(tokens)}
      </span>
    </>
  )
  // Indent via padding, not margin: group rows are w-full buttons, and a
  // margin would push their token column past the un-indented rows' edge.
  const cls = `flex items-baseline text-xs ${indent ? 'pl-4' : ''}`
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${cls} w-full text-left hover:text-[var(--adf-ui-text)]`}>
        {inner}
      </button>
    )
  }
  return <div className={cls}>{inner}</div>
}

function ToolGroup({ group }: { group: ContextBreakdownToolGroup }) {
  const [expanded, setExpanded] = useState(false)
  const sorted = [...group.tools].sort((a, b) => b.tokens - a.tokens)
  return (
    <>
      <Row
        label={`${group.source} (${group.tools.length})`}
        tokens={group.tokens}
        indent
        onClick={() => setExpanded((e) => !e)}
        expanded={expanded}
      />
      {expanded && (
        // A big MCP server expands to 100+ rows — scroll inside the group so
        // the modal itself stays a fixed, scannable height.
        <div className="max-h-44 space-y-1 overflow-y-auto">
          {sorted.map((tool) => (
            <div key={tool.name} className="flex items-baseline pl-8 pr-1 text-xs">
              <span className="truncate font-mono text-[var(--adf-ui-text-subtle)]">{tool.name}</span>
              <span className="ml-auto shrink-0 pl-3 font-mono tabular-nums text-[var(--adf-ui-text-subtle)]">
                {formatTokens(tool.tokens)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Per-request context cost breakdown for the open agent, opened from the
 * status-bar context gauge. Fetches on open; the agent must be running for
 * main to have an executor to measure (null otherwise).
 */
export function ContextBreakdownModal({
  open,
  onClose,
  filePath,
  threshold
}: {
  open: boolean
  onClose: () => void
  filePath: string | null
  threshold: number
}) {
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null)
  const [loading, setLoading] = useState(false)
  const tokenUsage = useAgentStore((s) => s.tokenUsage)

  const fetchBreakdown = useCallback(async () => {
    if (!filePath) {
      setBreakdown(null)
      return
    }
    setLoading(true)
    try {
      setBreakdown(await window.adfApi.getContextBreakdown(filePath))
    } catch {
      setBreakdown(null)
    } finally {
      setLoading(false)
    }
  }, [filePath])

  useEffect(() => {
    if (open) void fetchBreakdown()
  }, [open, fetchBreakdown])

  const b = breakdown
  // {{file}} injections get their own slices carved out of the system prompt,
  // so the bar shows where that section's weight actually comes from.
  const segments: BarSegment[] = []
  if (b) {
    const fileTokens = b.injected_files.reduce((sum, f) => sum + f.tokens, 0)
    segments.push({
      key: 'system',
      label: 'System prompt',
      color: 'bg-sky-500',
      tokens: Math.max(0, b.system_prompt_tokens - fileTokens)
    })
    b.injected_files.forEach((f, i) =>
      segments.push({
        key: `file:${f.path}`,
        label: f.path,
        color: FILE_COLORS[i % FILE_COLORS.length],
        tokens: f.tokens
      })
    )
    segments.push({ key: 'tools', label: 'Tools', color: 'bg-violet-500', tokens: b.tools_total_tokens })
    segments.push({ key: 'messages', label: 'Conversation', color: 'bg-emerald-500', tokens: b.messages_tokens })
    segments.push({ key: 'dynamic', label: 'Dynamic instructions', color: 'bg-amber-500', tokens: b.dynamic_instructions_tokens })
  }
  const total = segments.reduce((sum, seg) => sum + seg.tokens, 0)
  // Scale against the compact threshold so the empty track reads as headroom;
  // an over-threshold context simply fills the bar.
  const scale = Math.max(total, threshold, 1)

  const hasLastCall = tokenUsage.input > 0

  return (
    <Dialog open={open} onClose={onClose} title="Context breakdown" wide>
      {loading && !b ? (
        <p className="text-xs text-[var(--adf-ui-text-muted)]">Measuring context…</p>
      ) : !b ? (
        <p className="text-xs text-[var(--adf-ui-text-muted)]">
          No breakdown available — the agent hasn&apos;t run yet.
        </p>
      ) : (
        <div className="space-y-4">
          {/* Proportions vs. the auto-compact threshold */}
          <div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--adf-ui-canvas)] ring-1 ring-inset ring-[var(--adf-ui-separator)]">
              {segments.map((seg) => (
                <Tooltip
                  key={seg.key}
                  tip={`${seg.label}: ${formatTokens(seg.tokens)}`}
                  className={`block h-full ${seg.color}`}
                  style={{ width: `${(seg.tokens / scale) * 100}%` }}
                />
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--adf-ui-text-muted)]">
              {segments.map((seg) => (
                <span key={seg.key} className="flex items-center gap-1">
                  <span className={`h-2 w-2 rounded-sm ${seg.color}`} />
                  {seg.label}
                </span>
              ))}
              <span className="ml-auto font-mono tabular-nums">
                {formatTokens(total)} / {formatTokens(threshold)} before auto-compact
              </span>
            </div>
          </div>

          {/* Per-part rows, settings-table style */}
          <div className="space-y-1.5 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] p-3 ring-1 ring-inset ring-[var(--adf-ui-separator)]">
            <Row label="System prompt" tokens={b.system_prompt_tokens} />
            {b.injected_files.map((f) => (
              <Row key={f.path} label={f.path} tokens={f.tokens} indent />
            ))}
            <Row label="Tools" tokens={b.tools_total_tokens} />
            {b.tool_groups.map((group) => (
              <ToolGroup key={group.source} group={group} />
            ))}
            {/* Sum of the two sections above — reads as their subtotal. */}
            <div className="border-t border-[var(--adf-ui-separator)] pt-1.5">
              <Row label="Fixed overhead" tokens={b.overhead_tokens} bold />
              <p className="mt-0.5 text-[10px] text-[var(--adf-ui-text-subtle)]">
                System prompt + tool schemas — sent with every request.
              </p>
            </div>
            <div className="border-t border-[var(--adf-ui-separator)] pt-1.5">
              <Row label="Dynamic instructions" tokens={b.dynamic_instructions_tokens} />
            </div>
            <Row label="Conversation" tokens={b.messages_tokens} />
            <div className="border-t border-[var(--adf-ui-separator)] pt-1.5">
              <Row label="Total" tokens={total} bold />
            </div>
          </div>

          {/* Last real call's usage (from the loop, not re-measured) */}
          <div>
            <div className="mb-1 text-xs font-semibold text-[var(--adf-ui-text)]">Last call</div>
            {!hasLastCall ? (
              <p className="text-xs text-[var(--adf-ui-text-muted)]">No completed calls yet.</p>
            ) : (
              <div className="space-y-1.5 rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-canvas)] p-3 ring-1 ring-inset ring-[var(--adf-ui-separator)]">
                <Row label="Input" tokens={tokenUsage.input} />
                <Row label="Output" tokens={tokenUsage.output} />
                {tokenUsage.cache_read != null && <Row label="Cache read" tokens={tokenUsage.cache_read} />}
                {tokenUsage.cache_write != null && <Row label="Cache write" tokens={tokenUsage.cache_write} />}
                {tokenUsage.reasoning != null && <Row label="Reasoning" tokens={tokenUsage.reasoning} />}
                {tokenUsage.cost_usd != null && (
                  <div className="flex items-baseline text-xs">
                    <span className="text-[var(--adf-ui-text-muted)]">Cost</span>
                    <span className="ml-auto shrink-0 pl-3 font-mono tabular-nums text-[var(--adf-ui-text-subtle)]">
                      {formatUsd(tokenUsage.cost_usd)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
              Measured {new Date(b.computed_at).toLocaleTimeString()}
            </span>
            <Button onClick={() => void fetchBreakdown()} variant="ghost" size="compact" disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
