// /templates: Studio's Settings > Agent templates in the terminal. The list
// (shipped first, default / not reviewed / has run tags, notes and warning),
// a template's details (model, tools, instructions, files), and what Studio
// does with one: new, duplicate, rename, notes, make default, review + claim,
// reset a shipped template, delete (into the daemon's trash folder), and edit
// the instructions, the seed files and the config in $EDITOR. Every action
// re-reads the list from the daemon.

import { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore, useTuiSelector } from '../state/store'
import { List } from '../ui/List'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { truncate } from '../ui/text'
import { Form, type FieldSpec, type FormValues } from '../views/loops/Form'
import { LinesView } from '../views/inspect/LinesView'
import { DaemonError, type TemplateListResult } from '../api/types'
import type { OverlayProps } from '../views/types'
import { openIdentity } from '../identity/Onboarding'
import {
  INSTANTIATE_RULE,
  NAME_HINT,
  SEED_FILES,
  TEMPLATES_OVERLAY,
  blurb,
  copyName,
  detailLines,
  formatSize,
  nameProblem,
  noteProblem,
  reviewLines,
  sortTemplates,
  templateErrorText,
  templateTags,
  type SeedKey,
  type TemplateDetail,
  type TemplateReview,
  type TemplateSummary,
  type TemplatesOverlayProps,
} from './model'
import { editTemplateConfig, editTemplateInstructions, editTemplateSeedFile } from './ops'

type NameMode = 'new' | 'copy' | 'rename'

type Step =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'review'; id: string; review?: TemplateReview; error?: string }
  | { kind: 'password'; id: string }
  | { kind: 'name'; mode: NameMode; id?: string }
  | { kind: 'notes'; id: string }
  | { kind: 'files'; id: string }
  | { kind: 'busy'; label: string; back: Step }

interface DialogState {
  step: Step
  index: number
  fileIndex: number
  list: TemplateListResult | null
  detail: TemplateDetail | null
  loadError: { code?: string; message: string } | null
  error: string | null
}

type FileRow = { path: string; seed?: SeedKey; size: number }

function errorOf(err: unknown): { code?: string; message: string } {
  if (err instanceof DaemonError) {
    const body = err.body as { error?: string; code?: string } | null
    return { code: body?.code, message: body?.error ?? err.message }
  }
  return { message: err instanceof Error ? err.message : String(err) }
}

export function TemplatesDialog({ overlay, close: closeOverlay, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { suspendTerminal } = useApp()
  const props = (overlay.props ?? {}) as TemplatesOverlayProps
  // Dialog state lives in the store (keyed by this overlay), not in React:
  // a confirm dialog on top unmounts this one, and the flow that asked must
  // still land its result where the remounted dialog reads it.
  const slotKey = `${TEMPLATES_OVERLAY}.dialog:${overlay.id}`
  const initial = useRef<DialogState>({ step: props.id ? { kind: 'detail', id: props.id } : { kind: 'list' }, index: 0, fileIndex: 0, list: null, detail: null, loadError: null, error: null }).current
  const read = (): DialogState => (store.getState().viewState[slotKey] as DialogState | undefined) ?? initial
  const patch = (next: Partial<DialogState>) => store.actions.setViewState(slotKey, { ...read(), ...next })
  const { step, index, fileIndex, list, detail, loadError, error } = useTuiSelector(s => (s.viewState[slotKey] as DialogState | undefined) ?? initial)
  const setList = (value: TemplateListResult | null) => patch({ list: value })
  const setDetail = (value: TemplateDetail | null) => patch({ detail: value })
  const setLoadError = (value: DialogState['loadError']) => patch({ loadError: value })
  const setError = (value: string | null) => patch({ error: value })
  const setStep = (value: Step) => patch({ step: value })
  const setIndex = (value: number) => patch({ index: value })
  const setFileIndex = (value: number) => patch({ fileIndex: value })
  const close = () => { closeOverlay(); store.actions.setViewState(slotKey, null) }
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})

  const dialogWidth = Math.max(56, Math.min(width - 4, 104))
  const inner = dialogWidth - 4
  const templates = sortTemplates(list?.templates ?? [])
  const byId = (id: string) => templates.find(t => t.id === id)
  const label = (id: string) => byId(id)?.name ?? id

  // --- loading -------------------------------------------------------------------

  const loadList = async () => {
    try {
      const next = await store.client.templates()
      patch({ list: next, loadError: null })
    } catch (err) {
      setLoadError(errorOf(err))
    }
  }
  const loadDetail = async (id: string) => {
    try {
      const next = await store.client.templateDetail(id)
      patch({ detail: next, error: null })
    } catch (err) {
      patch({ detail: null, error: templateErrorText(errorOf(err).code, errorOf(err).message) })
    }
  }
  const refresh = async (id?: string) => {
    await loadList()
    if (id) await loadDetail(id)
  }
  // First mount only: a remount (after a confirm) keeps what the store holds.
  useEffect(() => { if (!read().list && !read().loadError) void refresh(props.id) }, [])

  const stepId = 'id' in step ? step.id : undefined
  useEffect(() => {
    if ((step.kind === 'detail' || step.kind === 'files') && step.id !== detail?.template?.id) void loadDetail(step.id)
  }, [step.kind, stepId])

  // --- actions -------------------------------------------------------------------

  /** Run one daemon write with a spinner; errors stay on the page they came from. */
  const act = async <T,>(labelText: string, back: Step, fn: () => Promise<T>): Promise<T | undefined> => {
    patch({ error: null, step: { kind: 'busy', label: labelText, back } })
    try {
      const result = await fn()
      return result
    } catch (err) {
      const { code, message } = errorOf(err)
      if (code === 'identity_not_ready') {
        close()
        openIdentity(store, { mode: 'status', then: TEMPLATES_OVERLAY, thenProps: { ...(stepId ? { id: stepId } : {}) }, reason: `${labelText}: ${message}` })
        return undefined
      }
      setError(templateErrorText(code, message))
      if (code === 'password_required' || code === 'wrong_password') setStep({ kind: 'password', id: (back as { id: string }).id })
      else setStep(back)
      return undefined
    }
  }

  const done = (message: string, next: Step) => {
    store.actions.toast(message, 'success')
    setStep(next)
  }

  const setDefault = async (id: string, back: Step) => {
    if (list?.defaultId === id) { store.actions.toast(`${label(id)} is already the default`, 'info'); return }
    const r = await act('Make default', back, () => store.client.setDefaultTemplate(id))
    if (!r) return
    await refresh(back.kind === 'detail' ? id : undefined)
    done(`New agents now start from ${label(id)}`, back)
  }

  const remove = async (t: TemplateSummary, back: Step) => {
    if (t.shipped) {
      store.actions.toast(`${t.name} is a shipped template: it cannot be deleted here, x resets it to the shipped version`, 'warn', 8000)
      return
    }
    const ok = await store.actions.confirm({
      title: `Delete ${t.name}`,
      message: `Delete "${t.name}"? The file moves to the daemon's templates-trash folder, next to the templates folder.${list?.defaultId === t.id ? ' New agents then start from Standard.' : ''}`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const r = await act(`Delete ${t.name}`, back, () => store.client.deleteTemplate(t.id))
    if (!r) return
    await refresh()
    setDetail(null)
    done(`${t.name} moved to ${r.trashFolder}`, { kind: 'list' })
  }

  const reset = async (t: TemplateSummary, back: Step) => {
    if (!t.shipped) { store.actions.toast(`${t.name} is your own template: only shipped templates reset`, 'info'); return }
    const ok = await store.actions.confirm({
      title: `Reset ${t.name}`,
      message: `Reset "${t.name}" to the version ADF ships? Your changes to it are lost.`,
      confirmLabel: 'Reset',
      danger: true,
    })
    if (!ok) return
    const r = await act(`Reset ${t.name}`, back, () => store.client.resetTemplate(t.id))
    if (!r) return
    await refresh(back.kind === 'detail' ? t.id : undefined)
    done(`${t.name} reset to the shipped version`, back)
  }

  const openReview = async (id: string, back: Step) => {
    const r = await act('Review', back, () => store.client.templateReview(id))
    if (!r) return
    if (!r.needsReview) { await refresh(); done(`${label(id)} is already reviewed`, back); return }
    setStep({ kind: 'review', id, review: r })
  }

  const accept = async (id: string, password?: string) => {
    const back: Step = { kind: 'review', id }
    const r = await act(`Claim ${label(id)}`, back, () => store.client.acceptTemplateReview(id, password))
    if (!r) return
    setValues({})
    await refresh(id)
    done(`${r.template?.name ?? label(id)} is yours now: new agents can start from it`, { kind: 'detail', id })
  }

  const openName = (mode: NameMode, t?: TemplateSummary) => {
    setErrors({}); setError(null)
    setValues({ name: mode === 'copy' && t ? copyName(t.name) : mode === 'rename' && t ? t.name : '' })
    setStep({ kind: 'name', mode, id: t?.id })
  }

  const submitName = async (mode: NameMode, id: string | undefined) => {
    const name = String(values.name ?? '').trim()
    const problem = nameProblem(name)
    if (problem) { setErrors({ name: problem }); return }
    const back: Step = { kind: 'name', mode, id }
    if (mode === 'rename' && id) {
      if (name === byId(id)?.name) { setStep({ kind: 'detail', id }); return }
      const r = await act('Rename', back, () => store.client.updateTemplate(id, { name }))
      if (!r) return
      await refresh(r.id)
      done(`Renamed to ${name}${r.id !== id ? ` (${r.id}.adf)` : ''}`, { kind: 'detail', id: r.id })
      return
    }
    const r = await act(mode === 'copy' ? 'Duplicate' : 'New template', back, () => store.client.createTemplate({ name, ...(mode === 'copy' && id ? { fromId: id } : {}) }))
    if (!r) return
    await refresh(r.id)
    done(mode === 'copy' ? `${name} created from ${label(id!)}` : `${name} created from the defaults`, { kind: 'detail', id: r.id })
  }

  const openNotes = (t: TemplateSummary) => {
    setErrors({}); setError(null)
    setValues({ description: t.templateDescription ?? '', warning: t.warning ?? '' })
    setStep({ kind: 'notes', id: t.id })
  }

  const submitNotes = async (id: string) => {
    const description = String(values.description ?? '')
    const warning = String(values.warning ?? '')
    const problems = { description: noteProblem(description) ?? undefined, warning: noteProblem(warning) ?? undefined }
    if (problems.description || problems.warning) { setErrors(problems); return }
    const r = await act('Save notes', { kind: 'notes', id }, () => store.client.updateTemplate(id, { description, warning }))
    if (!r) return
    await refresh(id)
    done(`Notes of ${label(id)} saved`, { kind: 'detail', id })
  }

  const edit = async (id: string, what: 'instructions' | 'config' | SeedKey, back: Step) => {
    const suspend = (run: () => void | Promise<void>) => suspendTerminal(async () => { await run() })
    const outcome = what === 'instructions'
      ? await editTemplateInstructions(store.actions, suspend, id)
      : what === 'config'
        ? await editTemplateConfig(store.actions, suspend, id)
        : await editTemplateSeedFile(store.actions, suspend, id, what)
    if (outcome === 'saved') await refresh(id)
    setStep(back)
  }

  const removeExtra = async (id: string, path: string) => {
    const ok = await store.actions.confirm({ title: `Remove ${path}`, message: `Remove ${path} from the ${label(id)} template? New agents made from it no longer get it.`, confirmLabel: 'Remove', danger: true })
    if (!ok) return
    const back: Step = { kind: 'files', id }
    const r = await act(`Remove ${path}`, back, () => store.client.removeTemplateFile(id, path))
    if (!r) return
    await refresh(id)
    done(`${path} removed from ${label(id)}`, back)
  }

  const toIdentity = () => {
    close()
    openIdentity(store, { mode: 'status', then: TEMPLATES_OVERLAY, thenProps: { ...(props.id ? { id: props.id } : {}) }, reason: 'Templates need your owner identity: set it up or unlock it first.' })
  }

  /** Keys every page of one template shares (list rows and details). */
  const templateKey = (input: string, t: TemplateSummary, back: Step): boolean => {
    switch (input) {
      case 's': void setDefault(t.id, back); return true
      case 'u': openName('copy', t); return true
      case 'm': openName('rename', t); return true
      case 't': openNotes(t); return true
      case 'a': if (t.reviewed) { store.actions.toast(`${t.name} is reviewed`, 'info'); return true } void openReview(t.id, back); return true
      case 'x': void reset(t, back); return true
      case 'd': void remove(t, back); return true
      default: return false
    }
  }

  // --- keys ----------------------------------------------------------------------

  useKeys((input, key) => {
    const cancel = key.escape || (key.ctrl && input === 'c')
    switch (step.kind) {
      case 'list':
        if (cancel) { close(); return true }
        if (!list && input === 'i') { toIdentity(); return true }
        if (!list && input === 'r') { void refresh(); return true }
        return false
      case 'detail': {
        if (key.ctrl && input === 'c') { close(); return true }
        if (key.escape) { if (props.id) close(); else { setError(null); setStep({ kind: 'list' }) } return true }
        const t = byId(step.id)
        if (!t) return false
        if (input === 'e') { void edit(t.id, 'instructions', step); return true }
        if (input === 'c') { void edit(t.id, 'config', step); return true }
        if (input === 'f') { setFileIndex(0); setStep({ kind: 'files', id: t.id }); return true }
        if (input === 'n') { openName('new'); return true }
        if (input === 'r') { void refresh(t.id); return true }
        return templateKey(input, t, step)
      }
      case 'review':
        if (cancel || input === 'n') { setError(null); setStep({ kind: 'detail', id: step.id }); return true }
        if (step.review && (key.return || input === 'y')) { void accept(step.id); return true }
        return false
      case 'files':
        if (cancel) { setStep({ kind: 'detail', id: step.id }); return true }
        return false
      case 'busy':
        return true
      default:
        return false
    }
  }, { layer: 'overlay', active: step.kind !== 'name' && step.kind !== 'notes' && step.kind !== 'password' })

  // --- views ---------------------------------------------------------------------

  const errorLine = error ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {error}</Text> : null
  const bodyHeight = Math.max(6, height - 10)
  /** Short terminals: the list drops its footer lines. */
  const compact = height < 26
  /** A LinesView no taller than its lines (plus the position row when it scrolls). */
  const fitLines = (count: number) => Math.min(bodyHeight, count + 1)

  if (step.kind === 'busy') {
    return (
      <Modal title="Templates" width={dialogWidth}>
        <Spinner label={`${step.label}…`} />
      </Modal>
    )
  }

  if (step.kind === 'name') {
    const t = step.id ? byId(step.id) : undefined
    const title = step.mode === 'new' ? 'New template' : step.mode === 'copy' ? `Duplicate ${t?.name ?? step.id}` : `Rename ${t?.name ?? step.id}`
    const note = step.mode === 'new'
      ? 'Starts from the built-in defaults. u on a template duplicates it instead.'
      : step.mode === 'copy'
        ? 'A copy of its config, files and notes, with a fresh identity and no history.'
        : 'This renames the file and the agent name inside it.'
    const fields: FieldSpec[] = [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'Template name', hint: NAME_HINT }]
    const back = () => { setError(null); setStep(step.id ? { kind: 'detail', id: step.id } : { kind: 'list' }) }
    return (
      <Modal title={title} width={dialogWidth} hints={[{ keys: 'enter', label: step.mode === 'rename' ? 'rename' : 'create' }, { keys: 'esc', label: 'cancel' }]}>
        <Text color={theme.color.muted} wrap="wrap">{note}</Text>
        <Box marginTop={1} flexDirection="column">
          <Form fields={fields} values={values} onChange={v => { setValues(v); setErrors({}) }} errors={errors} onSubmit={() => { void submitName(step.mode, step.id) }} onCancel={back} width={inner} height={3} cancelLabel="go back" />
        </Box>
        {errorLine}
      </Modal>
    )
  }

  if (step.kind === 'notes') {
    const fields: FieldSpec[] = [
      { kind: 'text', key: 'description', label: 'Description', placeholder: 'What this template is for', hint: 'Shown in the list and the new-agent wizard' },
      { kind: 'text', key: 'warning', label: 'Warning', placeholder: 'A caution shown wherever it is offered', hint: 'e.g. Runs code and reaches your host without asking' },
    ]
    return (
      <Modal title={`Notes ${theme.glyph.sep} ${label(step.id)}`} width={dialogWidth} hints={[{ keys: 'enter', label: 'next / save' }, { keys: 'ctrl+s', label: 'save' }, { keys: 'esc', label: 'cancel' }]}>
        <Text color={theme.color.muted} wrap="wrap">Shown wherever this template is offered. Neither line is copied into agents made from it. Empty clears.</Text>
        <Box marginTop={1} flexDirection="column">
          <Form fields={fields} values={values} onChange={v => { setValues(v); setErrors({}) }} errors={errors} onSubmit={() => { void submitNotes(step.id) }} onCancel={() => setStep({ kind: 'detail', id: step.id })} width={inner} height={5} cancelLabel="go back" />
        </Box>
        {errorLine}
      </Modal>
    )
  }

  if (step.kind === 'password') {
    const fields: FieldSpec[] = [{ kind: 'text', key: 'password', label: 'Password', mask: true, placeholder: 'the template file password' }]
    return (
      <Modal title={`Claim ${label(step.id)}`} width={dialogWidth} hints={[{ keys: 'enter', label: 'claim' }, { keys: 'esc', label: 'cancel' }]}>
        <Text color={theme.color.muted} wrap="wrap">This template is password-protected. Its password removes the protection as part of the claim.</Text>
        <Box marginTop={1} flexDirection="column">
          <Form fields={fields} values={values} onChange={setValues} onSubmit={() => { void accept(step.id, String(values.password ?? '')) }} onCancel={() => { setValues({}); setError(null); setStep({ kind: 'detail', id: step.id }) }} width={inner} height={3} cancelLabel="go back" />
        </Box>
        {errorLine}
      </Modal>
    )
  }

  if (step.kind === 'review') {
    return (
      <Modal title={`Review ${theme.glyph.sep} ${label(step.id)} template`} width={dialogWidth} hints={[{ keys: 'y enter', label: 'claim + accept' }, { keys: 'up down', label: 'scroll' }, { keys: 'n esc', label: 'cancel' }]}>
        {step.review ? <LinesView lines={reviewLines(step.review.summary, inner)} width={inner} height={fitLines(reviewLines(step.review.summary, inner).length)} keyLayer="overlay" /> : <Spinner label="reading the template…" />}
        {errorLine}
      </Modal>
    )
  }

  if (step.kind === 'files') {
    const contents = detail?.template?.id === step.id ? detail.contents : null
    const rows: FileRow[] = contents
      ? [
          ...SEED_FILES.map(f => ({ path: f.path, seed: f.key, size: Buffer.byteLength(contents.files[f.key] ?? '', 'utf-8') })),
          ...contents.extra.map(f => ({ path: f.path, size: f.size })),
        ]
      : []
    return (
      <Modal title={`Files ${theme.glyph.sep} ${label(step.id)}`} width={dialogWidth} hints={[{ keys: 'enter', label: 'edit in $EDITOR' }, { keys: 'd', label: 'remove extra' }, { keys: 'esc', label: 'back' }]}>
        <Text color={theme.color.muted} wrap="wrap">Starting content for a new agent's files. Extra files are copied into every new agent (add them in Studio).</Text>
        {!contents ? <Spinner label="reading files…" /> : (
          <List
            items={rows}
            getKey={r => r.path}
            height={Math.max(3, Math.min(rows.length, bodyHeight - 2))}
            width={inner}
            keyLayer="overlay"
            selectedIndex={Math.min(fileIndex, rows.length - 1)}
            onSelectedIndexChange={setFileIndex}
            onSubmit={r => {
              if (r.seed) void edit(step.id, r.seed, step)
              else store.actions.toast(`${r.path} is an extra file: editing it is not supported here (d removes it)`, 'info')
            }}
            onKey={(input, _key, r) => {
              if (input === 'd' && r) {
                if (r.seed) store.actions.toast(`${r.path} is a seed file: clear its text instead`, 'info')
                else void removeExtra(step.id, r.path)
                return true
              }
              return false
            }}
            renderItem={(r, { selected }) => (
              <Text wrap="truncate-end" inverse={theme.mono && selected}>
                <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
                <Text bold={selected} color={selected ? theme.color.accent : theme.color.text}>{truncate(r.path, 30).padEnd(31)}</Text>
                <Text color={theme.color.muted}>{(r.seed && r.size === 0 ? 'empty' : formatSize(r.size)).padEnd(10)}</Text>
                <Text color={theme.color.dim}>{r.seed ? 'seed file' : 'extra file'}</Text>
              </Text>
            )}
          />
        )}
        {errorLine}
      </Modal>
    )
  }

  if (step.kind === 'detail') {
    const t = byId(step.id)
    const ready = detail && detail.template?.id === step.id
    const hints = [
      { keys: 'e', label: 'instructions' },
      { keys: 'f', label: 'files' },
      { keys: 'c', label: 'config' },
      { keys: 't', label: 'notes' },
      ...(t && !t.reviewed ? [{ keys: 'a', label: 'review' }] : [{ keys: 's', label: 'default' }]),
      { keys: 'm', label: 'rename' },
      { keys: 'u', label: 'duplicate' },
      ...(t?.shipped ? [{ keys: 'x', label: 'reset' }] : [{ keys: 'd', label: 'delete' }]),
      { keys: 'esc', label: props.id ? 'close' : 'back' },
    ]
    return (
      <Modal title={`${t?.name ?? step.id} template${t && list?.defaultId === t.id ? ` ${theme.glyph.sep} default` : ''}${t?.shipped ? ` ${theme.glyph.sep} shipped` : ''}`} width={dialogWidth} hints={hints}>
        {t && !t.reviewed ? <Text color={theme.color.warn} wrap="wrap">{theme.glyph.warn} Not reviewed: someone else's template. a reviews it; new agents cannot start from it until you accept.</Text> : null}
        {!ready && !error ? <Spinner label="reading the template…" /> : null}
        {ready ? <LinesView lines={detailLines(detail, inner)} width={inner} height={fitLines(detailLines(detail, inner).length)} keyLayer="overlay" /> : null}
        {errorLine}
      </Modal>
    )
  }

  // list
  const selected = templates[Math.min(index, Math.max(0, templates.length - 1))]
  const nameWidth = Math.min(26, Math.max(12, ...templates.map(t => t.name.length + 1)))
  const hints = [
    { keys: 'enter', label: 'details' },
    { keys: 'n', label: 'new' },
    { keys: 'u', label: 'duplicate' },
    { keys: 's', label: 'default' },
    ...(selected && !selected.reviewed ? [{ keys: 'a', label: 'review' }] : []),
    { keys: 'd', label: 'delete' },
    { keys: 'esc', label: 'close' },
  ]
  return (
    <Modal title="Agent templates" width={dialogWidth} hints={loadError ? [...(loadError.code === 'identity_not_ready' ? [{ keys: 'i', label: 'owner identity' }] : []), { keys: 'r', label: 'retry' }, { keys: 'esc', label: 'close' }] : hints}>
      <Text color={theme.color.muted} wrap="truncate-end">Every agent you create starts from one of these. /new picks one.</Text>
      {loadError ? <Text color={loadError.code === 'identity_not_ready' ? theme.color.warn : theme.color.error} wrap="wrap">{theme.glyph.cross} {templateErrorText(loadError.code, loadError.message)}</Text> : null}
      {!list && !loadError ? <Spinner label="reading templates…" /> : null}
      {list ? (
        <Box marginTop={1} flexDirection="column">
          <List
            items={templates}
            getKey={t => t.id}
            height={Math.max(3, Math.min(templates.length || 1, height - (compact ? 11 : 16)))}
            width={inner}
            keyLayer="overlay"
            selectedIndex={Math.min(index, Math.max(0, templates.length - 1))}
            onSelectedIndexChange={setIndex}
            onSubmit={t => { setError(null); setStep({ kind: 'detail', id: t.id }) }}
            filter={(t, q) => `${t.name} ${t.id} ${blurb(t)}`.toLowerCase().includes(q.toLowerCase())}
            emptyText="No templates in the folder: n creates one."
            onKey={(input, _key, t) => {
              if (input === 'n') { openName('new'); return true }
              if (input === 'r') { void refresh(); return true }
              return t ? templateKey(input, t, { kind: 'list' }) : false
            }}
            renderItem={(t, { selected: current }) => {
              const tags = templateTags(t, list.defaultId)
              return (
                <Text wrap="truncate-end" inverse={theme.mono && current}>
                  <Text color={current ? theme.color.accent : theme.color.dim}>{current ? theme.glyph.pointer : ' '} </Text>
                  <Text bold={current} color={current ? theme.color.accent : theme.color.text}>{truncate(t.name, nameWidth - 1).padEnd(nameWidth)}</Text>
                  {tags.map((tag, i) => <Text key={i} color={tag.tone === 'accent' ? theme.color.accent : tag.tone === 'warn' ? theme.color.warn : tag.tone === 'dim' ? theme.color.dim : theme.color.muted}>{`[${tag.text}] `}</Text>)}
                  <Text color={theme.color.dim}>{blurb(t)}</Text>
                </Text>
              )
            }}
          />
          {selected ? (
            <Box marginTop={1} flexDirection="column">
              <Text wrap="wrap" color={theme.color.text}>{blurb(selected) || <Text color={theme.color.dim}>No description.</Text>}</Text>
              {selected.warning ? <Text wrap="wrap" color={theme.color.warn}>{theme.glyph.warn} {selected.warning}</Text> : null}
              {compact ? null : <Text wrap="truncate-end" color={theme.color.dim}>{[selected.modelProvider, selected.modelId].filter(Boolean).join(' / ') || 'no provider set: the default provider fills in'}</Text>}
            </Box>
          ) : null}
          {compact ? null : (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.color.dim} wrap="truncate-end">{INSTANTIATE_RULE}</Text>
              <Text color={theme.color.dim} wrap="truncate-end">Folder: {list.folder}</Text>
            </Box>
          )}
        </Box>
      ) : null}
      {errorLine}
    </Modal>
  )
}
