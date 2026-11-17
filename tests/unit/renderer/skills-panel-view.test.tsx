import React from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { fileRevision } from '../../../src/main/runtime/resource-revisions'
import { createAdfApi } from '../../../src/shared/adf-api'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { beginAgentSwitch, endAgentSwitch, useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import type { AdfApi } from '../../../src/preload/api'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { ContextMenuItem } from '../../../src/renderer/components/common/ContextMenu'
import { mount, type Mounted } from './support/host-render'

/**
 * The real Skills panel, mounted (support/host-render.ts), over real
 * workspaces. Rule: the panel shows the CURRENT view's skills or a loading
 * state, never the previous agent's rows (headed finding S9).
 */

;(globalThis as { React?: typeof React }).React = React

const backend = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('../../../src/renderer/utils/runtime-api', () => ({
  apiFor: () => backend.api,
  openApi: () => backend.api,
  useOpenRuntime: () => 'local',
}))
// The shared menu's portal/viewport behavior is tested separately. Keep its
// open/closed state and item selection here, without a browser DOM.
vi.mock('../../../src/renderer/components/common/ContextMenu', () => ({
  ContextMenu: ({ position, items, onClose }: { position: unknown; items: ContextMenuItem[]; onClose: () => void }) => position ? (
    <div role="menu">
      {items.map((item) => <button key={item.label} role="menuitem" disabled={item.disabled} onClick={() => { onClose(); item.onSelect() }}>{item.label}</button>)}
    </div>
  ) : null,
}))

import { SkillsPanel } from '../../../src/renderer/components/agent/SkillsPanel'

const settle = async (ms = 60) => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, ms / 5)) }

let failNextList = false
const dirs: string[] = []
const open: AdfWorkspace[] = []
let foreground: AdfWorkspace
let ui: Mounted | null = null

function agent(name: string, skills: string[]): { path: string; ws: AdfWorkspace } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-skills-view-'))
  dirs.push(dir)
  const path = join(dir, `${name}.adf`)
  const ws = AdfWorkspace.create(path, { name })
  open.push(ws)
  for (const skill of skills) ws.writeFile(`skills/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: ${skill} things.\n---\n`)
  ws.refreshSkillIndex()
  return { path, ws }
}

/** Studio main's pushes to the renderer, by channel (what ipcRenderer.on receives). */
const pushes: Record<string, Set<(...args: unknown[]) => void>> = {}
const push = (channel: string, payload: unknown) => { for (const handler of pushes[channel] ?? []) handler({}, payload) }

/** What Studio main answers the panel, for whichever workspace is in the foreground. */
function api(): AdfApi {
  return createAdfApi({
    runtimeId: 'local',
    invoke: async (channel: string, ...args: unknown[]) => {
      const arg = (args[0] ?? {}) as { path?: string; content?: string }
      if (channel === IPC.DOC_GET_FILES) { if (failNextList) { failNextList = false; throw new Error('daemon restarting') } return { files: foreground.listFiles() } }
      if (channel === IPC.DOC_READ_INTERNAL_FILE) {
        const buf = foreground.readFileBuffer(String(arg.path))
        return buf ? { content: buf.toString('utf8'), binary: false, revision: fileRevision(foreground, String(arg.path)).revision } : { content: null, binary: false }
      }
      if (channel === IPC.DOC_DELETE_INTERNAL_FILE) return { success: foreground.deleteFile(String(arg.path)) }
      if (channel === IPC.DOC_WRITE_INTERNAL_FILE) {
        foreground.writeFile(String(arg.path), String(arg.content))
        return { success: true }
      }
      throw new Error(`unexpected channel ${channel}`)
    },
    send: () => {},
    on: (channel: string, handler: (...args: unknown[]) => void) => { (pushes[channel] ??= new Set()).add(handler) },
    removeListener: (channel: string, handler: (...args: unknown[]) => void) => { pushes[channel]?.delete(handler) },
  } as never, { platform: 'linux', setZoomFactor: () => {} } as never) as unknown as AdfApi
}

/** The renderer's agent switch, in useAdfFile.openFile's order: switch window, main swaps, the view changes, the window closes. */
async function switchTo(target: { path: string; ws: AdfWorkspace }): Promise<void> {
  beginAgentSwitch()
  foreground = target.ws // main swaps its workspace inside the openFile IPC
  await settle(10)
  useDocumentStore.getState().setFilePath(target.path, 'local')
  await settle(10)
  endAgentSwitch()
}

let A: ReturnType<typeof agent>
let B: ReturnType<typeof agent>
beforeEach(async () => {
  A = agent('a', ['alpha-one', 'alpha-two'])
  B = agent('b', ['beta-only'])
  foreground = A.ws
  backend.api = api()
  useDocumentStore.getState().reset()
  useEditorTabsStore.getState().reset()
  useAgentStore.getState().setConfig({ id: 'x', name: 'x' } as unknown as AgentConfig)
  useDocumentStore.getState().setFilePath(A.path, 'local')
})
afterEach(() => {
  for (const key of Object.keys(pushes)) delete pushes[key]
  expect(ui?.errors ?? []).toEqual([])
  ui?.unmount()
  ui = null
  for (const ws of open.splice(0)) { try { ws.close() } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Skills panel = the current view', () => {
  it('A → B with the panel open shows B\'s skills only, once B is loaded', async () => {
    ui = mount(<SkillsPanel />)
    await settle()
    expect(ui.text()).toContain('alpha-one')
    await switchTo(B)
    await settle()
    expect(ui.text()).toContain('beta-only')
    expect(ui.text()).not.toContain('alpha-one')
    expect(ui.text()).toContain('1 skill installed')
  })

  it('A → B → A shows A\'s skills again, never B\'s', async () => {
    ui = mount(<SkillsPanel />)
    await settle()
    await switchTo(B)
    await switchTo(A)
    await settle()
    expect(ui.text()).toContain('alpha-two')
    expect(ui.text()).not.toContain('beta-only')
  })

  it('while the incoming agent is not readable yet, no previous agent\'s row is shown', async () => {
    ui = mount(<SkillsPanel />)
    await settle()
    beginAgentSwitch()
    foreground = B.ws
    useDocumentStore.getState().setFilePath(B.path, 'local')
    await settle()
    expect(ui.text()).not.toContain('alpha-one')
    endAgentSwitch()
  })

  it('an installed row\'s name carries its full name as a title (it truncates in a narrow panel)', async () => {
    ui = mount(<SkillsPanel />)
    await settle()
    const named = ui.find((n) => n.props.title === 'alpha-one')
    expect(named.length).toBeGreaterThan(0)
  })
})

/*
 * NEW-1 (headed): after an install into a STOPPED agent the panel kept the
 * pre-index answer ("not indexed", "0 skills") until a remount. A document
 * with no runtime attached raises no `file_updated`; the only push is the
 * workspace data signal (scope `files`), which every writer raises, the
 * indexer's registry rewrite included. Studio main forwards it as
 * WORKSPACE_DATA_CHANGED (ipc/index.ts; the daemon as workspace_data).
 */
describe('a stopped agent: the index\'s answer reaches the panel', () => {
  it('the indexer\'s registry rewrite raises the workspace `files` signal once the registry lists the skill', async () => {
    const scopes: Array<{ scope: string; listed: boolean }> = []
    A.ws.setOnDataChangeCallback((scope) => scopes.push({ scope, listed: !!JSON.parse(A.ws.readFile('skills-registry.json') ?? '{}').skills?.['gamma-new'] }))
    A.ws.writeFilesAtomic([{ path: 'skills/gamma-new/SKILL.md', content: Buffer.from('---\nname: gamma-new\ndescription: New.\n---\n'), expect: { mustNotExist: true } }])
    await settle(600)
    A.ws.setOnDataChangeCallback(null)
    expect(scopes.some((s) => s.scope === 'files' && s.listed)).toBe(true)
  })

  it('a batch written to a document with no runtime: the panel lists the skill once the registry is written, without a remount', async () => {
    // Studio main's forwarder for the open document (no runtime: no file_updated ever).
    A.ws.setOnDataChangeCallback((scope) => push(IPC.WORKSPACE_DATA_CHANGED, { scope }))
    ui = mount(<SkillsPanel />)
    await settle()
    expect(ui.text()).toContain('2 skills installed')
    A.ws.writeFilesAtomic([{ path: 'skills/gamma-new/SKILL.md', content: Buffer.from('---\nname: gamma-new\ndescription: New.\n---\n'), expect: { mustNotExist: true } }])
    await settle(900)
    A.ws.setOnDataChangeCallback(null)
    expect(ui.text()).toContain('gamma-new')
    expect(ui.text()).toContain('3 skills installed')
    expect(ui.text()).not.toContain('not indexed')
  })
})

describe('a failed read for the current view', () => {
  it('says so with Retry instead of loading forever; Retry reads it', async () => {
    ui = mount(<SkillsPanel />)
    await settle()
    failNextList = true
    await switchTo(B)
    await settle(300)
    expect(ui.text()).toContain('Could not read skills: daemon restarting')
    expect(ui.text()).not.toContain('Loading skills')
    expect(ui.text()).not.toContain('alpha-one')
    const retry = ui.find((n) => n.type === 'button' && n.children.some((c) => c.text === 'Retry'))[0]
    ;(retry.props.onClick as () => void)()
    await settle()
    expect(ui.text()).toContain('beta-only')
    expect(ui.text()).not.toContain('Could not read skills')
  })
})

async function openActions(name = 'alpha-one') {
  const button = ui!.find((n) => n.type === 'button' && n.props['aria-label'] === `Actions for ${name}`)[0]
  expect(button).toBeDefined()
  Object.assign(button, { getBoundingClientRect: () => ({ right: 300, bottom: 100 }) })
  ;(button.props.onClick as () => void)()
  await settle()
}

async function selectAction(label: string) {
  const item = ui!.find((n) => n.props.role === 'menuitem' && n.children.some((c) => c.text === label))[0]
  expect(item).toBeDefined()
  ;(item.props.onClick as () => void)()
  await settle()
}

async function requestRemoval(name = 'alpha-one') {
  await openActions(name)
  await selectAction('Remove skill')
}

async function answerRemoval(label: 'Cancel' | 'Remove skill') {
  const button = ui!.find((n) => n.type === 'button' && n.children.some((c) => c.text === label))[0]
  ;(button.props.onClick as () => void)()
  await settle()
}

describe('removing installed skills', () => {
  it('keeps controls in the three-dot menu and toggles skills from there', async () => {
    ui = mount(<SkillsPanel />)
    await settle()
    expect(ui.find((n) => n.props.type === 'checkbox')).toHaveLength(0)
    expect(ui.text()).not.toContain('Remove skill')
    await openActions()
    expect(ui.text()).toContain('Open in editor')
    expect(ui.text()).toContain('Turn off')
    await selectAction('Turn off')
    expect(JSON.parse(A.ws.readFile('skills-state.json')!).disabled).toContain('alpha-one')
    expect(ui.find((n) => n.props.role === 'menu')).toHaveLength(0)
    await openActions()
    await selectAction('Turn on')
    expect(JSON.parse(A.ws.readFile('skills-state.json')!).disabled).not.toContain('alpha-one')
    await openActions()
    await selectAction('Open in editor')
    expect(useEditorTabsStore.getState().activeTabPath).toBe('skills/alpha-one/SKILL.md')
  })

  it('cancel keeps the package; confirmation removes its nested files and closes their tabs', async () => {
    const resource = 'skills/alpha-one/references/guide.md'
    A.ws.writeFile(resource, 'local edits')
    useEditorTabsStore.getState().openTab(resource, 'local edits')
    ui = mount(<SkillsPanel />)
    await settle()
    await requestRemoval()
    expect(ui.text()).toContain('including local edits and unsaved changes')
    expect(A.ws.readFile('skills/alpha-one/SKILL.md')).not.toBeNull()
    await answerRemoval('Cancel')
    expect(A.ws.readFile(resource)).toBe('local edits')
    await requestRemoval()
    await answerRemoval('Remove skill')
    await settle(800)
    expect(A.ws.listFiles().filter((f) => f.path.startsWith('skills/alpha-one/'))).toEqual([])
    expect(A.ws.readFile('skills/alpha-two/SKILL.md')).not.toBeNull()
    expect(useEditorTabsStore.getState().tabs.some((t) => t.path === resource)).toBe(false)
    expect(ui.text()).toContain('1 skill installed')
    expect(ui.text()).not.toContain('alpha-one')
  })

  it('allows removal of muted skills and rejected packages', async () => {
    A.ws.writeFile('skills-state.json', JSON.stringify({ schema: 1, disabled: ['alpha-one'] }))
    A.ws.writeFile('skills/broken/SKILL.md', 'missing frontmatter')
    A.ws.refreshSkillIndex()
    ui = mount(<SkillsPanel />)
    await settle()
    expect(ui.text()).toContain('muted — description removed from context')
    await requestRemoval()
    await answerRemoval('Remove skill')
    await requestRemoval('broken')
    await answerRemoval('Remove skill')
    expect(A.ws.readFile('skills/alpha-one/SKILL.md')).toBeNull()
    expect(A.ws.readFile('skills/broken/SKILL.md')).toBeNull()
  })

  it('preflights protected resources before deleting the manifest', async () => {
    A.ws.writeFile('skills/alpha-one/keep.md', 'keep')
    A.ws.setFileProtection('skills/alpha-one/keep.md', 'no_delete')
    ui = mount(<SkillsPanel />)
    await settle()
    await requestRemoval()
    await answerRemoval('Remove skill')
    expect(A.ws.readFile('skills/alpha-one/SKILL.md')).not.toBeNull()
    expect(A.ws.readFile('skills/alpha-one/keep.md')).toBe('keep')
    expect(ui.text()).toContain('Cannot remove protected file')
  })

  it('does not delete anything if the agent switches while confirmation is open', async () => {
    ui = mount(<SkillsPanel />)
    await settle()
    await requestRemoval()
    await switchTo(B)
    await answerRemoval('Remove skill')
    expect(A.ws.readFile('skills/alpha-one/SKILL.md')).not.toBeNull()
    expect(B.ws.readFile('skills/beta-only/SKILL.md')).not.toBeNull()
  })
})
