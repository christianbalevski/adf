// Starter templates for the new-loop wizard. A template only prefills the
// form — nothing is created until the user reviews and confirms.

import { DEFAULT_NEW_LOOP_TOOLS, type ScheduleDraft } from './model'

export interface LoopTemplate {
  id: string
  title: string
  summary: string
  name: string
  goal: string
  /** Wanted tools; the wizard intersects them with what the host can grant. */
  tools: string[]
  autonomous: boolean
  autostart: boolean
  schedule: ScheduleDraft
}

const base = [...DEFAULT_NEW_LOOP_TOOLS]

export const LOOP_TEMPLATES: LoopTemplate[] = [
  {
    id: 'consolidator',
    title: 'Memory consolidator',
    summary: 'Tidies mind.md and notes on a recurring schedule (daily 03:00)',
    name: 'consolidator',
    goal: [
      'You consolidate this agent\'s memory.',
      'Each run: read mind.md and recent notes, merge duplicates, drop stale or contradicted facts, and keep what matters short and current.',
      'Never invent facts. When done, send main a one-line summary of what changed with loop_send, then end your turn with sys_set_state.',
    ].join('\n'),
    tools: [...base, 'fs_read', 'fs_list', 'fs_write'],
    autonomous: false,
    autostart: false,
    schedule: { kind: 'daily', value: '03:00', payload: 'Consolidate memory now.' },
  },
  {
    id: 'researcher',
    title: 'Researcher',
    summary: 'Researches what main (or you) hands over, on demand',
    name: 'researcher',
    goal: [
      'You research questions handed to you by main or the owner.',
      'Gather sources, check them against each other, and write findings to research/<topic>.md with links.',
      'Report a short answer plus the file path to main with loop_send, then end your turn with sys_set_state.',
    ].join('\n'),
    tools: [...base, 'sys_fetch', 'fs_read', 'fs_list', 'fs_write'],
    autonomous: true,
    autostart: false,
    schedule: { kind: 'none', value: '', payload: '' },
  },
  {
    id: 'critic',
    title: 'Critic / reviewer',
    summary: 'Reviews drafts main sends it before they go out, on demand',
    name: 'critic',
    goal: [
      'You are a critical reviewer. Main sends you drafts, plans or answers before acting on them.',
      'Point out errors, gaps, risks and unclear wording, most important first. Suggest concrete fixes. Do not rewrite everything.',
      'Reply to main with loop_send, then end your turn with sys_set_state.',
    ].join('\n'),
    tools: [...base, 'fs_read', 'fs_list'],
    autonomous: false,
    autostart: false,
    schedule: { kind: 'none', value: '', payload: '' },
  },
  {
    id: 'reflector',
    title: 'Reflector',
    summary: 'Reflects on recent work and lessons learned (every 6h)',
    name: 'reflector',
    goal: [
      'You reflect on this agent\'s recent work.',
      'Each run: look at recent notes and outcomes, note what went well, what failed and why, and write durable lessons to reflections.md.',
      'Tell main about any lesson that should change how it works (loop_send), then end your turn with sys_set_state.',
    ].join('\n'),
    tools: [...base, 'fs_read', 'fs_list', 'fs_write'],
    autonomous: false,
    autostart: false,
    schedule: { kind: 'every', value: '6h', payload: 'Reflect on the last few hours.' },
  },
  {
    id: 'blank',
    title: 'Blank loop',
    summary: 'Start from an empty form',
    name: '',
    goal: '',
    tools: [...base],
    autonomous: false,
    autostart: false,
    schedule: { kind: 'none', value: '', payload: '' },
  },
]

export function findTemplate(id: string | undefined): LoopTemplate | undefined {
  if (!id) return undefined
  const key = id.toLowerCase()
  return LOOP_TEMPLATES.find(t => t.id === key || t.title.toLowerCase() === key)
}

/** A free name derived from the template name (consolidator, consolidator-2, …). */
export function freeName(base: string, taken: string[]): string {
  if (!base) return ''
  if (!taken.includes(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!taken.includes(candidate)) return candidate
  }
  return base
}
