import type { AgentLogEntry } from '../stores/agent.store'
import { isSystemNotice, isTurnCompleteMarker } from './loop-activity'
import { mergeContextRow } from './loop-labels'

/** A delivered inter-loop message remains visible outside activity groups. */
export function isLoopMessageEntry(entry: AgentLogEntry): boolean {
  return entry.type === 'context'
    && entry.metadata?.category === 'loop'
    && typeof entry.metadata?.fromLoop === 'string'
}

interface ToolPair {
  call: AgentLogEntry | null
  result: AgentLogEntry | null
}

export type FindToolPair = (id: string) => ToolPair | undefined

export type DisplayItem =
  | { kind: 'entry'; id: string; entry: AgentLogEntry }
  | TranscriptActivity

export interface TranscriptActivity {
  kind: 'activity'
  id: string
  entries: AgentLogEntry[]
  hasImage: boolean
  revision: number
}

function isStatusChange(entry: AgentLogEntry): boolean {
  if (entry.type !== 'tool_call' || entry.metadata?.name !== 'sys_set_meta') return false
  const input = entry.metadata?.input as { key?: unknown; value?: unknown } | undefined
  return input?.key === 'status' && typeof input.value === 'string' && input.value.trim().length > 0
}

function isCollapsible(entry: AgentLogEntry, findPair: FindToolPair): boolean {
  if (isLoopMessageEntry(entry) || isSystemNotice(entry)) return false
  if (entry.type === 'thinking' || entry.type === 'context') return true
  if (entry.type !== 'tool_call') return false
  const name = entry.metadata?.name
  if (name === 'say' || name === 'ask') return false
  return !(isStatusChange(entry) && findPair(entry.id)?.result?.metadata?.isError === false)
}

type PendingCall = { entry: AgentLogEntry; index: number }

/** Incremental pairs and grouped rows for one loaded transcript. */
export class TranscriptProjection {
  readonly items: DisplayItem[] = []
  readonly visible: AgentLogEntry[] = []
  readonly largeGroups: number[] = []
  private readonly itemStarts: number[] = []
  private readonly mergedInto = new Map<string, string>()
  private readonly groupByEntry = new Map<string, TranscriptActivity>()
  private readonly completedPairs = new Map<string, ToolPair>()
  private readonly pendingById = new Map<string, PendingCall>()
  private readonly pendingByName = new Map<unknown, PendingCall>()
  private readonly pendingPairs = new Map<string, ToolPair>()
  private lastRawEntry: AgentLogEntry | undefined
  private tailIsCollapsible = false
  length = 0

  readonly findPair: FindToolPair = id => this.completedPairs.get(id) ?? this.pendingPairs.get(id)

  displayId(id: string): string {
    return this.mergedInto.get(id) ?? id
  }

  groupFor(id: string): TranscriptActivity | undefined {
    return this.groupByEntry.get(this.displayId(id))
  }

  append(log: readonly AgentLogEntry[]): void {
    let regroupAt = this.length
    for (let i = this.length; i < log.length; i++) {
      const entry = log[i]
      const pairedStatusAt = this.pairEntry(entry, i)
      if (pairedStatusAt !== undefined) regroupAt = Math.min(regroupAt, pairedStatusAt)
    }

    if (this.length > 0 && this.lastRawEntry !== log[this.length - 1]) {
      // A streamed text/thinking row can be replaced in place between
      // structural revisions. Once the next row lands, use its final text.
      const previous = log[this.length - 1]
      if (previous.id === this.tailEntry()?.id) {
        this.replaceTail(previous)
        this.visible[this.visible.length - 1] = previous
      }
    }

    for (let i = this.length; i < log.length; i++) {
      if (isDisplayEntry(log[i])) this.visible.push(log[i])
    }
    // A result can make an earlier folded status update a visible row. Keep
    // the items before its group and rebuild from the group's first raw row.
    const start = regroupAt < this.length ? this.truncateAtGroup(regroupAt) : this.length
    for (let i = start; i < log.length; i++) this.display(log[i], i)
    this.length = log.length
    this.lastRawEntry = log.at(-1)
  }

  private truncateAtGroup(rawIndex: number): number {
    let left = 0
    let right = this.itemStarts.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (this.itemStarts[middle] <= rawIndex) left = middle + 1
      else right = middle
    }
    const itemIndex = left - 1
    const start = this.itemStarts[itemIndex]
    for (let i = itemIndex; i < this.items.length; i++) {
      const item = this.items[i]
      if (item.kind === 'activity') for (const entry of item.entries) this.groupByEntry.delete(entry.id)
    }
    this.items.length = itemIndex
    this.itemStarts.length = itemIndex
    while (this.largeGroups.length && this.largeGroups.at(-1)! >= itemIndex) this.largeGroups.pop()
    const tail = this.tailEntry()
    this.tailIsCollapsible = tail !== undefined && isCollapsible(tail, this.findPair)
    return start
  }

  private pairEntry(entry: AgentLogEntry, index: number): number | undefined {
    if (entry.type === 'tool_call') {
      const toolId = entry.metadata?.tool_id as string | undefined
      const pending = { entry, index }
      const previous = toolId ? this.pendingById.get(toolId) : this.pendingByName.get(entry.metadata?.name)
      if (previous) this.pendingPairs.delete(previous.entry.id)
      if (toolId) this.pendingById.set(toolId, pending)
      else this.pendingByName.set(entry.metadata?.name, pending)
      this.pendingPairs.set(entry.id, { call: entry, result: null })
      return
    }
    if (entry.type !== 'tool_result') return

    const toolId = entry.metadata?.tool_use_id as string | undefined
    const name = entry.metadata?.name
    let pending = toolId ? this.pendingById.get(toolId) : undefined
    if (pending && toolId) this.pendingById.delete(toolId)
    else {
      pending = this.pendingByName.get(name)
      this.pendingByName.delete(name)
    }
    const pair = { call: pending?.entry ?? null, result: entry }
    this.completedPairs.set(entry.id, pair)
    if (!pending) return
    this.pendingPairs.delete(pending.entry.id)
    this.completedPairs.set(pending.entry.id, pair)
    const group = this.groupFor(pending.entry.id)
    if (group) {
      group.revision++
      if (entry.metadata?.imageUrl) group.hasImage = true
    }
    if (entry.metadata?.isError === false && isStatusChange(pending.entry)) return pending.index
  }

  private tailEntry(): AgentLogEntry | undefined {
    const item = this.items.at(-1)
    return item?.kind === 'activity' ? item.entries.at(-1) : item?.entry
  }

  private replaceTail(entry: AgentLogEntry): void {
    const item = this.items.at(-1)!
    if (item.kind === 'activity') {
      item.entries[item.entries.length - 1] = entry
      item.revision++
    } else this.items[this.items.length - 1] = { ...item, entry }
  }

  private addActivityEntry(group: TranscriptActivity, entry: AgentLogEntry): void {
    group.entries.push(entry)
    group.revision++
    this.groupByEntry.set(entry.id, group)
    if (this.findPair(entry.id)?.result?.metadata?.imageUrl) group.hasImage = true
    if (group.entries.length === WINDOW_ACTIVITY_STEPS) this.largeGroups.push(this.items.length - 1)
  }

  private display(entry: AgentLogEntry, index: number): void {
    if (!isDisplayEntry(entry)) return
    const merged = mergeContextRow(this.tailEntry(), entry)
    if (merged) {
      this.mergedInto.set(entry.id, merged.id)
      this.replaceTail(merged)
      return
    }

    const collapsible = isCollapsible(entry, this.findPair)
    const tail = this.items.at(-1)
    if (collapsible && this.tailIsCollapsible && tail) {
      if (tail.kind === 'activity') this.addActivityEntry(tail, entry)
      else {
        const group: TranscriptActivity = { kind: 'activity', id: `activity:${tail.id}`, entries: [], hasImage: false, revision: 0 }
        this.addActivityEntry(group, tail.entry)
        this.addActivityEntry(group, entry)
        this.items[this.items.length - 1] = group
      }
    } else {
      this.itemStarts.push(index)
      this.items.push({ kind: 'entry', id: entry.id, entry })
    }
    this.tailIsCollapsible = collapsible
  }
}

function isDisplayEntry(entry: AgentLogEntry): boolean {
  return entry.type !== 'tool_result' && !isTurnCompleteMarker(entry)
}

export const WINDOW_ACTIVITY_STEPS = 64
type ActivityWindow = { start: number; group: TranscriptActivity; extraBefore: number; length: number }

export interface TranscriptRow {
  key: string
  item: DisplayItem
  child?: number
  windowed?: boolean
}

/** Map expanded activity children onto the same scroll surface as the rest of chat. */
export function createTranscriptRows(
  archive: TranscriptProjection,
  live: TranscriptProjection,
  archiveEnd: DisplayItem,
  expanded: (group: TranscriptActivity) => boolean,
) {
  const archiveCount = archive.items.length ? archive.items.length + 1 : 0
  const itemAt = (index: number) => index >= archiveCount
    ? live.items[index - archiveCount]
    : archive.items[index] ?? archiveEnd
  const windows: ActivityWindow[] = []
  let extra = 0
  const addWindows = (projection: TranscriptProjection, offset: number) => {
    for (const index of projection.largeGroups) {
      const group = projection.items[index]
      if (group.kind !== 'activity' || !expanded(group)) continue
      windows.push({ start: index + offset + extra, group, extraBefore: extra, length: group.entries.length })
      extra += group.entries.length
    }
  }
  addWindows(archive, 0)
  addWindows(live, archiveCount)

  const windowAt = (index: number): ActivityWindow | undefined => {
    let left = 0
    let right = windows.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (windows[middle].start <= index) left = middle + 1
      else right = middle
    }
    return windows[left - 1]
  }

  const count = archiveCount + live.items.length + extra

  function rowAt(index: number): TranscriptRow | undefined {
    if (index < 0 || index >= count) return undefined
    const window = windowAt(index)
    if (window) {
      const relative = index - window.start
      const { group } = window
      if (relative === 0) return { key: group.id, item: group, windowed: true }
      if (relative <= window.length) {
        return { key: group.entries[relative - 1].id, item: group, child: relative - 1 }
      }
    }
    const indexInItems = window ? index - window.extraBefore - window.length : index
    const item = itemAt(indexInItems)
    return item ? { key: item.id, item } : undefined
  }

  /** Return a child index when windowed, otherwise the owning group. */
  function indexOf(entryId: string): number {
    entryId = live.displayId(archive.displayId(entryId))
    let extraBefore = 0
    let windowIndex = 0
    for (let index = 0; index < archiveCount + live.items.length; index++) {
      const item = itemAt(index)
      const start = index + extraBefore
      if (item.id === entryId) return start
      if (item.kind !== 'activity') continue
      const windowed = windows[windowIndex]?.start === start
      const child = item.entries.findIndex(entry => entry.id === entryId)
      if (child >= 0) return windowed ? start + child + 1 : start
      if (windowed) {
        extraBefore += item.entries.length
        windowIndex++
      }
    }
    return -1
  }

  return { count, rowAt, indexOf }
}
