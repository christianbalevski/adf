// /skills: the selected agent's skills (parity with Studio's Skills panel).
// Installed list with description, token estimate and muted state; Enter
// previews SKILL.md, Space mutes, e edits in $EDITOR, d removes. `a` (or
// /skills add) browses the merged catalog with type-to-filter and a preview
// before install; a URL or a local path previews that package instead.
// Dialog state lives in the store (viewState 'skills'): a confirm dialog or
// the editor's save prompt replaces this one for a moment and it comes back
// where it was.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Box, Text, useApp, useBoxMetrics, type DOMElement } from 'ink'
import * as panelNs from '../../../shared/utils/skills-panel'
import * as previewNs from '../../../shared/utils/skill-preview'
import type { MergedCatalogEntry } from '../../../shared/utils/skills-panel'
import { useTheme } from '../app/theme'
import { WHEEL_STEP, useKeys, useWheel } from '../app/keys'
import { useStore, useTuiSelector } from '../state/store'
import { List } from '../ui/List'
import { Modal } from '../ui/Modal'
import { Markdown } from '../ui/Markdown'
import { Spinner } from '../ui/Spinner'
import { fit, truncate } from '../ui/text'
import type { KeyHintSpec } from '../ui/KeyHint'
import type { OverlayProps } from '../views/types'
import { editTarget } from '../views/files/editor'
import { cjs } from '../interop'
import { loadCatalogSources, readCatalogSources } from './catalog'
import {
  EMPTY_VIEW_STATE,
  SKILLS_OVERLAY,
  buildInstalled,
  exactEntry,
  initialStep,
  packageKey,
  previewParts,
  safe,
  settleOverrides,
  tokenLabel,
  type InstalledSkill,
  type SkillPackage,
  type SkillsOverlayProps,
  type SkillsStep,
  type SkillsViewState,
} from './model'
import { installPackage, loadInstalled, loadPackage, readSkillFile, removeSkill, setSkillMuted, type InstalledData } from './ops'

const { catalogSourceLabel, filterCatalogEntries, mergeCatalogResults, unindexedHint, MAX_SKILL_FILE_BYTES } = cjs(panelNs)
const { elideMiddle } = cjs(previewNs)

type Row =
  | { type: 'skill'; key: string; skill: InstalledSkill }
  | { type: 'problem'; key: string; label: string; path: string; reason: string | null; isPackage: boolean }

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function SkillsDialog({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { suspendTerminal } = useApp()
  const props = (overlay.props ?? {}) as SkillsOverlayProps
  const agentId = props.agentId ?? store.getState().selectedAgentId ?? ''
  const agent = useTuiSelector(s => s.agents[agentId])
  const who = agent?.summary.handle || agent?.summary.name || agentId
  const direct = props.add !== undefined || !!props.skill

  // --- state (store-held) ---------------------------------------------------------
  const fresh = useMemo<SkillsViewState>(() => {
    const start = initialStep(props)
    return { ...EMPTY_VIEW_STATE, overlayId: overlay.id, step: start.step, query: start.query, extra: start.extra }
  }, [overlay.id])
  const raw = useTuiSelector(s => s.viewState[SKILLS_OVERLAY] as SkillsViewState | undefined)
  const vs = raw && raw.overlayId === overlay.id ? raw : fresh
  const read = (): SkillsViewState => {
    const current = store.getState().viewState[SKILLS_OVERLAY] as SkillsViewState | undefined
    return current && current.overlayId === overlay.id ? current : fresh
  }
  /** Write this dialog's slice; never over another open skills dialog's. */
  const patch = (next: Partial<SkillsViewState> | ((s: SkillsViewState) => Partial<SkillsViewState>)) => {
    const state = store.getState()
    const current = state.viewState[SKILLS_OVERLAY] as SkillsViewState | undefined
    if (current && current.overlayId !== overlay.id && state.overlays.some(o => o.id === current.overlayId)) return
    const base = read()
    store.actions.setViewState(SKILLS_OVERLAY, { ...base, ...(typeof next === 'function' ? next(base) : next), overlayId: overlay.id })
  }
  useEffect(() => { if (!raw || raw.overlayId !== overlay.id) patch({}) }, [overlay.id])
  const step = vs.step
  const setStep = (next: SkillsStep) => patch({ step: next })

  // --- installed data -------------------------------------------------------------
  const [data, setData] = useState<InstalledData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    loadInstalled(store.client, agentId).then(next => {
      if (cancelled || !alive.current) return
      setData(next); setLoadError(null)
      patch(s => ({ overrides: settleOverrides(s.overrides, next.registryText) }))
    }, err => { if (!cancelled && alive.current) setLoadError(errorText(err)) })
    return () => { cancelled = true }
  }, [agentId, vs.rev])

  const model = useMemo(() => (data ? buildInstalled(data.files, data.registryText, vs.overrides) : null), [data, vs.overrides])
  const rows: Row[] = useMemo(() => model ? [
    ...model.skills.map((skill): Row => ({ type: 'skill', key: `s:${skill.name}`, skill })),
    ...model.problems.map((p): Row => ({ type: 'problem', key: `p:${p.key}`, label: p.label, path: p.path, reason: p.reason, isPackage: p.isPackage })),
  ] : [], [model])

  /** Refetch now and once more after the indexer's debounce has written the registry. */
  const bump = () => {
    patch(s => ({ rev: s.rev + 1 }))
    setTimeout(() => patch(s => ({ rev: s.rev + 1 })), 700)
  }

  // --- catalog --------------------------------------------------------------------
  const needsCatalog = step.kind === 'catalog' || (step.kind === 'package' && step.source.type === 'catalog')
  useEffect(() => {
    if (!needsCatalog || read().catalog) return
    const extra = read().extra
    patch({ catalog: { loading: true, sources: extra, results: [] } })
    void (async () => {
      const configured = await readCatalogSources(store.client)
      const sources = [...extra, ...configured.sources.filter(url => !extra.includes(url))]
      patch({ catalog: { loading: true, sources, results: [], sourcesNote: configured.note } })
      const results = await loadCatalogSources(sources)
      patch(s => ({ catalog: { loading: false, sources, results, sourcesNote: configured.note } }))
      const now = read()
      if (now.step.kind === 'catalog' && now.step.autoPreview) {
        const hit = exactEntry(mergeCatalogResults(results), now.query)
        patch({ step: hit ? { kind: 'package', source: { type: 'catalog', entry: hit }, back: 'catalog' } : { kind: 'catalog' } })
      }
    })()
  }, [needsCatalog])
  const merged = useMemo(() => mergeCatalogResults(vs.catalog?.results ?? []), [vs.catalog?.results])
  const visible = useMemo(() => filterCatalogEntries(merged, vs.query), [merged, vs.query])

  // --- package preview --------------------------------------------------------------
  const pkgKey = step.kind === 'package' ? packageKey(step.source) : null
  const pkgState = pkgKey ? vs.packages[pkgKey] : undefined
  const loadPkg = (force = false) => {
    if (step.kind !== 'package' || !pkgKey) return
    if (!force && read().packages[pkgKey]) return
    const source = step.source
    patch(s => ({ packages: { ...s.packages, [pkgKey]: { status: 'loading' } } }))
    void loadPackage(source).then(result => {
      patch(s => ({ packages: { ...s.packages, [pkgKey]: result.ok ? { status: 'ready', pkg: result.pkg } : { status: 'error', error: result.error } } }))
    }, err => patch(s => ({ packages: { ...s.packages, [pkgKey]: { status: 'error', error: errorText(err) } } })))
  }
  useEffect(() => { loadPkg() }, [pkgKey])

  // --- installed SKILL.md preview -----------------------------------------------------
  const [doc, setDoc] = useState<{ path: string; text: string | null; error?: string } | null>(null)
  const viewPath = step.kind === 'view' ? step.path : null
  useEffect(() => {
    if (!viewPath || !agentId) return
    let cancelled = false
    readSkillFile(store.client, agentId, viewPath).then(
      text => { if (!cancelled && alive.current) setDoc({ path: viewPath, text }) },
      err => { if (!cancelled && alive.current) setDoc({ path: viewPath, text: null, error: errorText(err) }) },
    )
    return () => { cancelled = true }
  }, [viewPath, vs.rev])

  // --- actions ----------------------------------------------------------------------
  const toggle = async (skill: InstalledSkill) => {
    const name = skill.name
    const enabled = !skill.enabled
    patch(s => ({ overrides: { ...s.overrides, [name]: enabled } }))
    const error = await setSkillMuted(store.client, agentId, name, enabled)
    if (error) {
      patch(s => { const overrides = { ...s.overrides }; delete overrides[name]; return { overrides } })
      store.actions.toast(error, 'error')
      return
    }
    store.actions.toast(enabled ? `${name} unmuted: back in ${who}'s skill catalog` : `${name} muted: its description left ${who}'s prompt`, 'success', 3000)
    bump()
  }

  const remove = async (name: string) => {
    const ok = await store.actions.confirm({
      title: `Remove ${name}`,
      message: `Delete skills/${name}/ (SKILL.md and every file beside it) from ${who}? The skill leaves its catalog on the next turn.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    const outcome = await store.actions.run(`Remove ${name}`, c => removeSkill(c, agentId, name))
    if (!outcome) return
    if (outcome.failed.length) store.actions.toast(`${name}: ${outcome.deleted} deleted, not deleted: ${outcome.failed.join('; ')}`, 'warn', 10_000)
    else store.actions.toast(`Removed ${name} from ${who} (${outcome.deleted} file${outcome.deleted === 1 ? '' : 's'})`, 'success')
    if (read().step.kind === 'view') patch({ step: { kind: 'list' } })
    bump()
  }

  const edit = async (path: string) => {
    await editTarget({
      client: store.client,
      actions: store.actions,
      agentId,
      agentLabel: who,
      suspend: run => suspendTerminal(run),
    }, { kind: 'file', path })
    bump()
  }

  const install = async (pkg: SkillPackage, key: string) => {
    if (read().installs[key]?.status === 'installing') return
    patch(s => ({ installs: { ...s.installs, [key]: { status: 'installing' } } }))
    const outcome = await installPackage(store.client, agentId, pkg).catch(err => ({ error: errorText(err), warnings: [] as string[], written: 0 }))
    patch(s => ({ installs: { ...s.installs, [key]: outcome.error ? { status: 'error', error: outcome.error, warnings: outcome.warnings } : { status: 'done', warnings: outcome.warnings } } }))
    if (outcome.error) store.actions.toast(`Install ${pkg.name} failed: ${outcome.error}`, 'error', 10_000)
    else if (outcome.warnings.length) store.actions.toast(`Installed ${pkg.name} in ${who} without ${outcome.warnings.length} file${outcome.warnings.length === 1 ? '' : 's'}: ${outcome.warnings.join('; ')}`, 'warn', 10_000)
    else store.actions.toast(`Installed ${pkg.name} in ${who} (${outcome.written} file${outcome.written === 1 ? '' : 's'})`, 'success')
    bump()
  }

  const backFromPackage = () => {
    if (step.kind !== 'package') return
    if (step.back === 'close') close()
    else setStep(step.back === 'catalog' ? { kind: 'catalog' } : { kind: 'list' })
  }

  // --- keys ------------------------------------------------------------------------
  useKeys((input, key) => {
    if (key.ctrl && input === 'c') { close(); return true }
    switch (step.kind) {
      case 'list':
        if (key.escape) { close(); return true }
        if (input === 'a') { setStep({ kind: 'catalog' }); return true }
        if (input === 'r') { bump(); return true }
        return false
      case 'view': {
        if (key.escape) { if (props.skill) close(); else setStep({ kind: 'list' }); return true }
        const skill = model?.skills.find(s => s.name === step.name)
        if (input === ' ' && skill) { void toggle(skill); return true }
        if (input === 'e') { void edit(step.path); return true }
        if (input === 'd') { void remove(step.name); return true }
        return false
      }
      case 'catalog':
        if (key.escape) {
          if (vs.query) patch({ query: '', catalogCursor: 0 })
          else if (props.add !== undefined) close()
          else setStep({ kind: 'list' })
          return true
        }
        if (key.backspace || key.delete) { patch(s => ({ query: s.query.slice(0, -1), catalogCursor: 0 })); return true }
        if (input && !key.ctrl && !key.meta && !key.return && !key.tab && !/[\r\n\t\u001b]/.test(input)) {
          patch(s => ({ query: s.query + input, catalogCursor: 0 }))
          return true
        }
        return false
      case 'package': {
        if (key.escape) { backFromPackage(); return true }
        if (pkgState?.status === 'error' && input === 'r') { loadPkg(true); return true }
        if ((key.return || input === 'i') && pkgState?.status === 'ready' && pkgKey) { void install(pkgState.pkg, pkgKey); return true }
        return false
      }
    }
  }, { layer: 'overlay' })

  // --- layout -----------------------------------------------------------------------
  const dialogWidth = Math.max(40, Math.min(width - 2, 100))
  const inner = dialogWidth - 4
  const contentRows = Math.max(6, height - 10)
  const title = `Skills ${theme.glyph.sep} ${who}`

  if (!agent) {
    return (
      <Modal title="Skills" width={dialogWidth} onClose={close} hints={[{ keys: 'esc', label: 'close' }]}>
        <Text wrap="wrap" color={theme.color.warn}>Select an agent first, or create one with /new. Skills belong to one agent.</Text>
      </Modal>
    )
  }

  // --- installed list ---
  if (step.kind === 'list') {
    const hints: KeyHintSpec[] = [
      { keys: 'enter', label: 'preview' }, { keys: 'space', label: 'mute' }, { keys: 'e', label: 'edit' },
      { keys: 'd', label: 'remove' }, { keys: 'a', label: 'add' }, { keys: 'esc', label: 'close' },
    ]
    const summary = model
      ? `${model.skills.length} skill${model.skills.length === 1 ? '' : 's'}, ${model.muted} muted${model.registryTokens ? ` ${theme.glyph.sep} catalog ${tokenLabel(model.registryTokens)} in the prompt` : ''}`
      : ''
    const empty = !model ? null
      : model.status === 'none' ? `No skills installed. a adds one from the catalog, a URL or a folder. Every skills/<name>/SKILL.md in ${who} is indexed into its prompt.`
        : model.status === 'not-generated' ? 'The skill catalog has not been generated yet: it appears on the next workspace write (r refreshes).'
          : model.status === 'unreadable' ? 'skills-registry.json could not be read: the runtime rewrites it on the next workspace write.'
            : null
    const listRows = Math.max(2, Math.min(contentRows - 2, Math.max(6, rows.length * 2)))
    return (
      <Modal title={title} width={dialogWidth} hints={hints}>
        <Text color={theme.color.muted} wrap="truncate-end">{loadError ? '' : summary}</Text>
        {loadError ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {loadError}</Text> : null}
        {!model && !loadError ? <Spinner label="reading skills…" /> : null}
        {model && empty && rows.length === 0 ? (
          <Box height={listRows}><Text color={model.status === 'unreadable' ? theme.color.warn : theme.color.muted} wrap="wrap">{empty}</Text></Box>
        ) : model ? (
          <List<Row>
            items={rows}
            getKey={r => r.key}
            height={listRows}
            width={inner}
            itemHeight={2}
            keyLayer="overlay"
            selectedIndex={Math.min(vs.cursor, Math.max(0, rows.length - 1))}
            onSelectedIndexChange={index => patch({ cursor: index })}
            onSubmit={r => setStep({ kind: 'view', name: r.type === 'skill' ? r.skill.name : r.label, path: r.type === 'skill' ? r.skill.path : r.path })}
            onKey={(input, _key, r) => {
              if (!r) return false
              if (input === ' ' && r.type === 'skill') { void toggle(r.skill); return true }
              if (input === 'e') { void edit(r.type === 'skill' ? r.skill.path : r.path); return true }
              if (input === 'd' && (r.type === 'skill' || r.isPackage)) { void remove(r.type === 'skill' ? r.skill.name : r.label); return true }
              return false
            }}
            renderItem={(r, { selected }) => <InstalledRow row={r} selected={selected} width={inner} />}
          />
        ) : null}
        <Text color={theme.color.dim} wrap="truncate-end">Skills are instructions, never authority: no tools, files or approvals come with them.</Text>
      </Modal>
    )
  }

  // --- installed SKILL.md ---
  if (step.kind === 'view') {
    const skill = model?.skills.find(s => s.name === step.name)
    const problem = model?.problems.find(p => p.label === step.name)
    const hints: KeyHintSpec[] = [
      { keys: 'up down', label: 'scroll' }, ...(skill ? [{ keys: 'space', label: skill.enabled ? 'mute' : 'unmute' }] : []),
      { keys: 'e', label: 'edit' }, { keys: 'd', label: 'remove' }, { keys: 'esc', label: props.skill ? 'close' : 'back' },
    ]
    const state = skill ? (skill.enabled ? `on ${theme.glyph.sep} listed in ${who}'s skill catalog` : 'muted: description removed from context') : problem ? (problem.reason ? `not indexed: ${safe(problem.reason)}` : unindexedHint()) : ''
    const text = doc && doc.path === step.path ? doc : null
    return (
      <Modal title={`${title} ${theme.glyph.sep} ${safe(step.name)}`} width={dialogWidth} hints={hints}>
        <Text wrap="truncate-end">
          <Text color={theme.color.muted}>{step.path}</Text>
          {skill?.tokens ? <Text color={theme.color.dim}>{`  ${theme.glyph.sep} ${tokenLabel(skill.tokens)} when read`}</Text> : null}
        </Text>
        <Text wrap="truncate-end" color={skill ? (skill.enabled ? theme.color.success : theme.color.warn) : theme.color.warn}>{state || ' '}</Text>
        {!text ? <Spinner label="reading SKILL.md…" />
          : text.error ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {text.error}</Text>
            : text.text === null ? <Text color={theme.color.warn} wrap="wrap">{step.path} is missing or binary.</Text>
              : <SkillDoc key={step.path} manifest={text.text} width={inner} height={Math.max(3, contentRows - 3)} />}
      </Modal>
    )
  }

  // --- catalog ---
  if (step.kind === 'catalog') {
    const catalog = vs.catalog
    const loading = !catalog || catalog.loading
    const noSources = !!catalog && !catalog.loading && catalog.sources.length === 0
    const failures = (catalog?.results ?? []).filter(r => !r.ok)
    const chips = (catalog?.results ?? []).map(r => `${catalogSourceLabel(r.url, r.publisher)}: ${r.ok ? `${r.entries.length} loaded${r.dropped ? `, ${r.dropped} invalid` : ''}` : safe(r.error)}`).join(`  ${theme.glyph.sep} `)
    const count = vs.query ? `${visible.length} of ${merged.length}` : `${merged.length}`
    const hints: KeyHintSpec[] = [
      { keys: 'enter', label: 'preview' }, { keys: 'up down', label: 'move' }, { keys: 'esc', label: vs.query ? 'clear' : props.add !== undefined ? 'close' : 'back' },
    ]
    const listRows = Math.max(2, contentRows - 3)
    return (
      <Modal title={`${title} ${theme.glyph.sep} add`} width={dialogWidth} hints={hints}>
        <Text wrap="truncate-end">
          <Text color={theme.color.accent}>Search </Text>
          <Text color={theme.color.text}>{vs.query}</Text>
          <Text inverse> </Text>
          {vs.query ? null : <Text color={theme.color.dim}> type to filter by name or description</Text>}
        </Text>
        <Text color={theme.color.muted} wrap="truncate-end">
          {loading ? '' : `${count} skill${merged.length === 1 ? '' : 's'} ${theme.glyph.sep} ${catalog?.sources.length ?? 0} source${catalog?.sources.length === 1 ? '' : 's'}${chips ? `  ${theme.glyph.sep} ${chips}` : ''}`}
        </Text>
        {catalog?.sourcesNote ? <Text color={theme.color.warn} wrap="truncate-end">{catalog.sourcesNote}</Text> : <Text> </Text>}
        {noSources ? (
          <Box height={listRows}><Text color={theme.color.muted} wrap="wrap">No catalog sources configured (Studio: Settings, Skills; or /skills sources add &lt;https-url&gt;). /skills add &lt;url|path&gt; installs one package directly.</Text></Box>
        ) : loading ? (
          <Box height={listRows}><Spinner label="loading catalogs…" /></Box>
        ) : merged.length === 0 ? (
          <Box height={listRows}><Text color={theme.color.muted} wrap="wrap">{failures.length > 0 && failures.length === (catalog?.results.length ?? 0) ? 'No source could be reached.' : 'These sources list no skills.'}</Text></Box>
        ) : (
          <List<MergedCatalogEntry>
            items={visible}
            getKey={e => `${e.sourceUrl}#${e.name}`}
            height={listRows}
            width={inner}
            itemHeight={2}
            keyLayer="overlay"
            selectedIndex={Math.min(vs.catalogCursor, Math.max(0, visible.length - 1))}
            onSelectedIndexChange={index => patch({ catalogCursor: index })}
            onSubmit={e => setStep({ kind: 'package', source: { type: 'catalog', entry: e }, back: 'catalog' })}
            emptyText={`No skill matches "${safe(vs.query)}". Esc clears the search.`}
            renderItem={(e, { selected }) => <CatalogRow entry={e} installed={!!model?.installed.has(e.name)} selected={selected} width={inner} />}
          />
        )}
      </Modal>
    )
  }

  // --- package preview (catalog entry, URL, or local folder) ---
  const pkg = pkgState?.status === 'ready' ? pkgState.pkg : null
  const installState = pkgKey ? vs.installs[pkgKey] : undefined
  const installed = !!pkg && !!model?.installed.has(pkg.name)
  const origin = step.source.type === 'catalog' ? step.source.entry.raw_url : step.source.type === 'url' ? step.source.url : step.source.path
  const name = step.source.type === 'catalog' ? step.source.entry.name : pkg?.name ?? ''
  const busy = installState?.status === 'installing'
  const hints: KeyHintSpec[] = [
    ...(pkg ? [{ keys: 'enter', label: busy ? 'installing…' : installed ? 'reinstall' : 'install' }] : pkgState?.status === 'error' ? [{ keys: 'r', label: 'retry' }] : []),
    { keys: 'up down', label: 'scroll' },
    { keys: 'esc', label: step.back === 'close' ? 'close' : 'back' },
  ]
  const resources = pkg?.resources ?? []
  const notes: Array<{ text: string; color?: string }> = []
  if (installState?.status === 'error') notes.push({ text: `${theme.glyph.cross} Install failed: ${safe(installState.error)}`, color: theme.color.error })
  if (installState?.status === 'done') notes.push({ text: `${theme.glyph.check} Installed in ${who}${installState.warnings.length ? ` without: ${safe(installState.warnings.join('; '))}` : ''}`, color: installState.warnings.length ? theme.color.warn : theme.color.success })
  for (const warning of pkg?.warnings ?? []) notes.push({ text: `${theme.glyph.warn} ${safe(warning)}`, color: theme.color.warn })
  const headerRows = 3 + (resources.length ? 1 : 0) + notes.length
  return (
    <Modal title={`${title} ${theme.glyph.sep} ${name ? safe(name) : 'package'}`} width={dialogWidth} hints={hints}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.accent}>{safe(name) || '…'}</Text>
        {installed ? <Text color={theme.color.success}>{`  ${theme.glyph.check} installed`}</Text> : null}
        {pkg ? <Text color={theme.color.dim}>{`  ${theme.glyph.sep} ${safe(pkg.label)}`}</Text> : null}
        {pkg ? <Text color={theme.color.dim}>{`  ${theme.glyph.sep} ${tokenLabel(Math.ceil(Buffer.byteLength(pkg.manifest, 'utf-8') / 4))}`}</Text> : null}
      </Text>
      <Text color={theme.color.text} wrap="truncate-end">{safe(pkg?.description ?? (step.source.type === 'catalog' ? step.source.entry.description : '')) || ' '}</Text>
      <Text color={theme.color.dim} wrap="truncate-end">{safe(elideMiddle(origin, inner))}</Text>
      {resources.length ? (
        <Text color={theme.color.muted} wrap="truncate-end">{`Also installs ${resources.length} file${resources.length === 1 ? '' : 's'} under skills/${pkg!.name}/: ${resources.map(r => safe(r.path)).join(', ')}`}</Text>
      ) : null}
      {notes.map((note, i) => <Text key={i} color={note.color} wrap="truncate-end">{note.text}</Text>)}
      {!pkgState || pkgState.status === 'loading' ? <Box marginTop={1}><Spinner label="reading SKILL.md…" /></Box>
        : pkgState.status === 'error' ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} Could not read this skill: {safe(pkgState.error)}</Text>
            <Text color={theme.color.dim} wrap="wrap">{`A package over ${Math.round(MAX_SKILL_FILE_BYTES / 1024)} KB, or one that is not text, is refused: the same bound the indexer enforces.`}</Text>
          </Box>
        ) : <SkillDoc key={pkgKey ?? ''} manifest={pkgState.pkg.manifest} width={inner} height={Math.max(3, contentRows - headerRows - 1)} />}
    </Modal>
  )
}

function InstalledRow({ row, selected, width }: { row: Row; selected: boolean; width: number }) {
  const theme = useTheme()
  const pointer = <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
  if (row.type === 'problem') {
    return (
      <Box flexDirection="column" width={width}>
        <Text wrap="truncate-end" inverse={theme.mono && selected}>
          {pointer}
          <Text color={theme.color.warn}>{`${theme.glyph.warn} `}</Text>
          <Text bold={selected} color={theme.color.warn}>{safe(row.label)}</Text>
          <Text color={theme.color.dim}>{`  ${row.isPackage ? 'not indexed' : 'rejected'}`}</Text>
        </Text>
        <Text wrap="truncate-end" color={theme.color.warn}>{`    ${row.reason ? safe(row.reason) : unindexedHint()}`}</Text>
      </Box>
    )
  }
  const skill = row.skill
  const tokens = tokenLabel(skill.tokens)
  const nameWidth = Math.max(8, width - 4 - tokens.length - 10)
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end" inverse={theme.mono && selected}>
        {pointer}
        <Text color={skill.enabled ? theme.color.success : theme.color.dim}>{`${skill.enabled ? theme.glyph.dot : theme.glyph.ring} `}</Text>
        <Text bold={selected} color={selected ? theme.color.accent : skill.enabled ? theme.color.text : theme.color.muted}>{fit(safe(skill.name), nameWidth)}</Text>
        <Text color={skill.enabled ? theme.color.dim : theme.color.warn}>{fit(skill.enabled ? '' : 'muted', 7)}</Text>
        <Text color={theme.color.dim}>{tokens}</Text>
      </Text>
      <Text wrap="truncate-end" color={skill.enabled ? theme.color.muted : theme.color.dim}>
        {`    ${skill.enabled ? (skill.description ? safe(skill.description) : '(no description)') : 'muted: description removed from context'}`}
      </Text>
    </Box>
  )
}

function CatalogRow({ entry, installed, selected, width }: { entry: MergedCatalogEntry; installed: boolean; selected: boolean; width: number }) {
  const theme = useTheme()
  const label = safe(entry.sourceLabel)
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate-end" inverse={theme.mono && selected}>
        <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
        <Text bold={selected} color={selected ? theme.color.accent : theme.color.text}>{safe(entry.name)}</Text>
        {installed ? <Text color={theme.color.success}>{`  ${theme.glyph.check} installed`}</Text> : null}
        <Text color={theme.color.dim}>{`  ${theme.glyph.sep} ${truncate(label, 32)}`}</Text>
      </Text>
      <Text wrap="truncate-end" color={theme.color.muted}>{`  ${safe(entry.description)}`}</Text>
    </Box>
  )
}

/**
 * SKILL.md as markdown-lite: the frontmatter as key/value rows, then the body
 * (ui/Markdown). Scrolls in place: ↑↓/jk, PgUp/PgDn/space, g/G, the wheel.
 * Remote or agent-written text: fields and body are sanitized first.
 */
function SkillDoc({ manifest, width, height }: { manifest: string; width: number; height: number }) {
  const theme = useTheme()
  const parts = useMemo(() => previewParts(manifest), [manifest])
  const [offset, setOffset] = useState(0)
  const innerRef = useRef<DOMElement>(null)
  const outerRef = useRef<DOMElement>(null)
  const metrics = useBoxMetrics(innerRef as RefObject<DOMElement>)
  const rows = Math.max(1, height - 1)
  const total = metrics.hasMeasured ? metrics.height : 0
  const maxOffset = Math.max(0, total - rows)
  const at = Math.min(offset, maxOffset)
  const move = (next: number) => setOffset(Math.max(0, Math.min(maxOffset, next)))
  useWheel(outerRef, delta => move(at + delta * WHEEL_STEP), { layer: 'overlay' })
  useKeys((input, key) => {
    if (key.upArrow || (input === 'k' && !key.ctrl)) { move(at - 1); return true }
    if (key.downArrow || (input === 'j' && !key.ctrl)) { move(at + 1); return true }
    if (key.pageUp) { move(at - rows); return true }
    if (key.pageDown) { move(at + rows); return true }
    if (key.home || input === 'g') { move(0); return true }
    if (key.end || input === 'G') { move(maxOffset); return true }
    return false
  }, { layer: 'overlay' })
  const keyWidth = Math.min(16, Math.max(4, ...parts.fields.map(f => f.key.length)) + 1)
  return (
    <Box ref={outerRef} flexDirection="column" width={width} height={height} marginTop={1}>
      <Box height={rows} overflow="hidden" flexDirection="column">
        <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-at} width={width}>
          {parts.fields.map(field => (
            <Box key={field.key} width={width}>
              <Box width={keyWidth} flexShrink={0}><Text color={theme.color.info}>{truncate(field.key, keyWidth - 1)}</Text></Box>
              <Box flexShrink={1}><Text color={theme.color.muted} wrap="wrap">{field.value || ' '}</Text></Box>
            </Box>
          ))}
          {parts.fields.length ? <Text color={theme.color.dim}>{theme.glyph.hbar.repeat(Math.max(1, Math.min(width, 24)))}</Text> : null}
          {parts.body ? <Markdown text={parts.body} color={theme.color.text} /> : <Text color={theme.color.dim}>This SKILL.md has no body: only frontmatter.</Text>}
        </Box>
      </Box>
      <Text color={theme.color.dim} wrap="truncate-end">{total > rows ? `${at + 1}-${Math.min(total, at + rows)} of ${total} lines` : ' '}</Text>
    </Box>
  )
}
