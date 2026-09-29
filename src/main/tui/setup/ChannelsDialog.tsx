// /channels: the selected agent's channels with their live state; add one
// (pick, paste its credentials masked, save: credentials into the agent's
// sealed keystore, then the config write that switches it on), see one
// (state, error, what to do next), remove one. Secrets live in this
// component's state only: never in the store, overlay props, toasts or logs.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore, useTuiSelector } from '../state/store'
import { List } from '../ui/List'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { truncate } from '../ui/text'
import { Form, type FieldSpec, type FormValues } from '../views/loops/Form'
import { INSPECT_VIEW, patchInspectState } from '../views/inspect/state'
import type { OverlayProps } from '../views/types'
import type { AgentAdaptersDiagnostics } from '../api/types'
import type { AdapterRegistryEntry } from '../../../shared/constants/adapter-registry'
import { channelsIdentityReady, identityFirst } from './open'
import {
  CHANNELS_OVERLAY,
  DEFAULT_ADAPTER_CONFIG,
  adapterLiveState,
  channelEntries,
  configuredChannels,
  credentialFields,
  findChannel,
  validateCredentials,
  type AdapterLiveState,
  type ChannelsOverlayProps,
} from './channels'

type Step =
  | { kind: 'list' }
  | { kind: 'form'; entry: AdapterRegistryEntry; editing: boolean }
  | { kind: 'saving'; entry: AdapterRegistryEntry }
  | { kind: 'detail'; entry: AdapterRegistryEntry; saved?: 'on' | 'updated' }
  | { kind: 'remove'; entry: AdapterRegistryEntry; busy?: boolean }

const POLL_MS = 1000
const POLL_FOR_MS = 20_000

export function ChannelsDialog({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const props = (overlay.props ?? {}) as ChannelsOverlayProps
  const agentId = props.agentId ?? store.getState().selectedAgentId ?? ''
  const agent = useTuiSelector(s => s.agents[agentId])
  const who = agent?.summary.handle || agent?.summary.name || agentId
  const entries = useMemo(channelEntries, [])
  const direct = findChannel(props.channel)
  const [step, setStep] = useState<Step>(direct ? { kind: 'form', entry: direct, editing: false } : { kind: 'list' })
  const [index, setIndex] = useState(0)
  const [diag, setDiag] = useState<AgentAdaptersDiagnostics | null>(null)
  // Secrets: component state only.
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const configured = diag ? diag.configured.map(c => c.type) : configuredChannels(agent?.config as never)
  const isOn = (type: string) => configured.includes(type)
  const stateOf = (type: string): AdapterLiveState => adapterLiveState(diag, type)

  const refresh = async () => {
    try {
      const d = await store.client.agentAdapters(agentId)
      if (alive.current) setDiag(d)
      return d
    } catch {
      return null
    }
  }
  useEffect(() => { if (agentId) void refresh() }, [agentId])

  // Detail: poll the live state until it settles.
  useEffect(() => {
    if (step.kind !== 'detail') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const tick = async () => {
      const d = await refresh()
      if (stopped) return
      const status = adapterLiveState(d, step.entry.type).status
      if (status === 'connected' || status === 'error' || status === 'not running') return
      if (Date.now() - started < POLL_FOR_MS) timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [step.kind, step.kind === 'detail' ? step.entry.type : ''])

  const dialogWidth = Math.max(50, Math.min(width - 4, 84))
  const inner = dialogWidth - 4
  const backOrClose = () => { if (direct) close(); else setStep({ kind: 'list' }) }

  const openForm = (entry: AdapterRegistryEntry, editing: boolean) => {
    if (!channelsIdentityReady(store)) {
      close()
      identityFirst(store, CHANNELS_OVERLAY, { agentId, channel: entry.type }, 'Channel credentials are sealed under your owner identity: set it up first, then the channel setup follows.')
      return
    }
    setValues({}); setErrors({}); setFormError(null)
    setStep({ kind: 'form', entry, editing })
  }

  const save = async (entry: AdapterRegistryEntry, editing: boolean) => {
    const typed = Object.fromEntries(credentialFields(entry).map(f => [f.key, typeof values[f.key] === 'string' ? (values[f.key] as string).trim() : '']))
    // Editing keeps what is stored: an empty field leaves that credential as it is.
    const problems = Object.fromEntries(Object.entries(validateCredentials(entry, typed)).filter(([key]) => !(editing && !typed[key])))
    if (Object.keys(problems).length > 0) { setErrors(problems); return }
    setErrors({}); setFormError(null)
    setStep({ kind: 'saving', entry })
    try {
      // Credentials first: the config write (re)starts the channel and must find them.
      for (const field of credentialFields(entry)) {
        const value = typed[field.key]
        if (value) await store.client.setAdapterCredential(agentId, entry.type, field.key, value)
      }
    } catch (err) {
      if (!alive.current) return
      setFormError(`Could not store the credentials on ${who}: ${err instanceof Error ? err.message : String(err)}`)
      setStep({ kind: 'form', entry, editing })
      return
    }
    setValues({})
    try {
      const result = await store.client.attachAdapter(agentId, entry.type, DEFAULT_ADAPTER_CONFIG)
      if (!alive.current) return
      setStep({ kind: 'detail', entry, saved: result.alreadyAttached ? 'updated' : 'on' })
      void store.actions.loadConfig(agentId)
    } catch (err) {
      if (!alive.current) return
      setFormError(`The credentials are stored on ${who}, but ${entry.displayName} could not be switched on: ${err instanceof Error ? err.message : String(err)}. Nothing is listening yet; save again to retry.`)
      setStep({ kind: 'form', entry, editing })
    }
  }

  // Asked inline: a confirm dialog on top would unmount this one mid-flow.
  const remove = async (entry: AdapterRegistryEntry) => {
    setStep({ kind: 'remove', entry, busy: true })
    const result = await store.actions.run(`Remove ${entry.displayName}`, c => c.detachAdapter(agentId, entry.type))
    if (!alive.current) return
    if (result) {
      store.actions.toast(`${entry.displayName} removed from ${who}${result.deletedCredentials ? ` (${result.deletedCredentials} credential${result.deletedCredentials === 1 ? '' : 's'} deleted)` : ''}`, 'success')
      void store.actions.loadConfig(agentId)
      await refresh()
    }
    if (!alive.current) return
    if (direct) close(); else setStep({ kind: 'list' })
  }

  const openInspect = () => {
    close()
    patchInspectState(store.actions, store.getState(), { tab: 'channels' })
    store.actions.setView(INSPECT_VIEW)
  }

  useKeys((input, key) => {
    if (step.kind === 'saving') return true
    if (step.kind === 'remove') {
      if (step.busy) return true
      if (input === 'y' || input === 'Y' || key.return) { void remove(step.entry); return true }
      if (input === 'n' || input === 'N' || key.escape || (key.ctrl && input === 'c')) { setStep({ kind: 'detail', entry: step.entry }); return true }
      return true
    }
    if (step.kind === 'list') {
      if (key.escape || (key.ctrl && input === 'c')) { close(); return true }
      return false
    }
    if (step.kind === 'detail') {
      if (key.ctrl && input === 'c') { close(); return true }
      if (key.escape || key.return) { backOrClose(); return true }
      if (input === 'i') { openInspect(); return true }
      if (input === 'e') { openForm(step.entry, true); return true }
      if (input === 'd') { setStep({ kind: 'remove', entry: step.entry }); return true }
      if (input === 'r') { void refresh(); return true }
      return true
    }
    return false
  }, { layer: 'overlay', active: step.kind !== 'form' })

  if (!agent) {
    return (
      <Modal title="Channels" width={dialogWidth} onClose={close} hints={[{ keys: 'esc', label: 'close' }]}>
        <Text wrap="wrap" color={theme.color.warn}>Select an agent first, or create one with /new. Channels connect to one agent.</Text>
      </Modal>
    )
  }

  if (step.kind === 'list') {
    const selected = entries[Math.min(index, entries.length - 1)]
    return (
      <Modal
        title={`Channels ${theme.glyph.sep} ${who}`}
        width={dialogWidth}
        hints={[{ keys: 'enter', label: selected && isOn(selected.type) ? 'details' : 'add' }, { keys: 'a', label: 'add' }, { keys: 'd', label: 'remove' }, { keys: 'esc', label: 'close' }]}
      >
        <Text color={theme.color.muted} wrap="truncate-end">Where {who} talks to people outside ADF.</Text>
        <List
          items={entries}
          getKey={e => e.type}
          height={entries.length}
          width={inner}
          keyLayer="overlay"
          selectedIndex={index}
          onSelectedIndexChange={setIndex}
          onSubmit={e => (isOn(e.type) ? setStep({ kind: 'detail', entry: e }) : openForm(e, false))}
          onKey={(input, _key, e) => {
            if (!e) return false
            if (input === 'a') {
              if (!isOn(e.type)) { openForm(e, false); return true }
              const off = entries.findIndex(x => !isOn(x.type))
              if (off >= 0) setIndex(off)
              return true
            }
            if (input === 'd' && isOn(e.type)) { setStep({ kind: 'remove', entry: e }); return true }
            if (input === 'e' && isOn(e.type)) { openForm(e, true); return true }
            return false
          }}
          renderItem={(e, { selected: current }) => {
            const on = isOn(e.type)
            const live = stateOf(e.type)
            return (
              <Text wrap="truncate-end" inverse={theme.mono && current}>
                <Text color={current ? theme.color.accent : theme.color.dim}>{current ? theme.glyph.pointer : ' '} </Text>
                <Text bold={current} color={current ? theme.color.accent : theme.color.text}>{e.displayName.padEnd(10)}</Text>
                {on ? <LiveBadge state={live} /> : <Text color={theme.color.dim}>{'off'.padEnd(13)}</Text>}
                <Text color={theme.color.dim}>{e.tagline ?? e.description}</Text>
              </Text>
            )
          }}
        />
      </Modal>
    )
  }

  const entry = step.entry
  const title = `${entry.displayName} ${theme.glyph.sep} ${who}`

  if (step.kind === 'remove') {
    return (
      <Modal title={`Remove ${entry.displayName}`} width={dialogWidth} hints={step.busy ? [] : [{ keys: 'y enter', label: 'Remove' }, { keys: 'n esc', label: 'Keep' }]}>
        <Text color={theme.color.warn} wrap="wrap">Disconnect {who} from {entry.displayName}? Its stored {entry.displayName} credentials are deleted from the agent.</Text>
        {step.busy ? <Spinner label="removing…" /> : null}
      </Modal>
    )
  }

  if (step.kind === 'detail') {
    const live = stateOf(entry.type)
    const running = agent.status?.runtimeState
    const waiting = live.status === 'connecting' || live.status === 'unknown'
    return (
      <Modal title={title} width={dialogWidth} hints={[{ keys: 'i', label: 'Inspect › Channels' }, { keys: 'e', label: 'edit keys' }, { keys: 'd', label: 'remove' }, { keys: 'esc', label: direct ? 'close' : 'back' }]}>
        {step.saved ? <Text color={theme.color.success} wrap="wrap">{theme.glyph.check} {entry.displayName} {step.saved === 'updated' ? 'updated' : 'switched on'} for {who}. Its credentials are sealed in the agent.</Text> : null}
        <Box marginTop={step.saved ? 1 : 0}>
          {waiting ? <Spinner label={live.status === 'connecting' ? 'connecting…' : 'waiting for the channel…'} /> : <LiveLine state={live} />}
        </Box>
        {live.status === 'not running' || (running === 'stopped' || running === 'error')
          ? <Text wrap="wrap" color={theme.color.muted}>{who} is not running: /start {who} brings {entry.displayName} up.</Text>
          : null}
        {entry.type === 'whatsapp' ? <Text wrap="wrap" color={theme.color.muted}>{WHATSAPP_PAIRING}</Text> : null}
        {entry.type === 'telegram' && live.status === 'connected' ? <Text wrap="wrap" color={theme.color.muted}>Message your bot once in Telegram so it can see you.</Text> : null}
      </Modal>
    )
  }

  const fields = credentialFields(entry)
  const editing = step.kind === 'form' && step.editing
  const setupSteps = entry.setupSteps ?? []
  const formFields: FieldSpec[] = fields.map(f => ({
    kind: 'text',
    key: f.key,
    label: f.label,
    placeholder: editing ? 'stored · type to replace' : `paste here${f.placeholder ? ` (${f.placeholder})` : ''}${f.required ? '' : ', optional'}`,
    hint: f.hint,
    mask: true,
  }))
  // The numbered "where to get this" steps, as many as fit.
  const stepRows = Math.max(0, Math.min(setupSteps.length, height - 13 - fields.length * 2))

  return (
    <Modal
      title={title}
      width={dialogWidth}
      onClose={fields.length === 0 && step.kind === 'form' ? backOrClose : undefined}
      hints={step.kind === 'saving' ? [] : [{ keys: 'enter', label: fields.length ? 'next / save' : 'switch on' }, ...(fields.length ? [{ keys: 'ctrl+s', label: 'save' }] : []), { keys: 'esc', label: 'cancel' }]}
    >
      {setupSteps.slice(0, stepRows).map((s, i) => (
        <Text key={i} wrap="truncate-end" color={theme.color.muted}>
          <Text color={theme.color.accent}>{i + 1}.</Text> {truncate(s.url && i === 0 ? `${s.text} ${s.url}` : s.text, inner - 3)}
        </Text>
      ))}
      {setupSteps.length > stepRows && entry.docsUrl ? <Text color={theme.color.dim} wrap="truncate-end">Guide: {entry.docsUrl}</Text> : null}
      <Box marginTop={stepRows > 0 ? 1 : 0} flexDirection="column">
        {fields.length > 0 ? (
          <Form
            fields={formFields}
            values={values}
            onChange={v => { setValues(v); setFormError(null) }}
            errors={errors}
            onSubmit={() => { void save(entry, editing) }}
            onCancel={backOrClose}
            width={inner}
            height={Math.max(3, fields.length * 3)}
            active={step.kind === 'form'}
            cancelLabel={direct ? 'close' : 'go back'}
          />
        ) : (
          <NoCredentials onSubmit={() => { void save(entry, editing) }} active={step.kind === 'form'} name={entry.displayName} />
        )}
      </Box>
      {step.kind === 'saving' ? <Spinner label="sealing credentials and switching it on…" /> : null}
      {formError ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {formError}</Text> : null}
    </Modal>
  )
}

/** The QR is an image: Studio shows it; the terminal points at the file. */
export const WHATSAPP_PAIRING = 'Pair a phone: with the agent running, open imported/whatsapp/pairing-qr.png from its files (or ADF Studio, which shows the QR) and scan it in WhatsApp → Linked Devices → Link a device. The QR refreshes every minute until paired.'

function NoCredentials({ onSubmit, active, name }: { onSubmit: () => void; active: boolean; name: string }) {
  const theme = useTheme()
  useKeys((_input, key) => {
    if (key.return) { onSubmit(); return true }
    return false
  }, { layer: 'overlay', active })
  return <Text wrap="wrap" color={theme.color.text}>No credentials needed. Enter switches {name} on; you then pair a phone by QR code.</Text>
}

function LiveBadge({ state }: { state: AdapterLiveState }) {
  const theme = useTheme()
  const color = state.status === 'connected' ? theme.color.success : state.status === 'error' ? theme.color.error : theme.color.warn
  const glyph = state.status === 'connected' ? theme.glyph.dot : state.status === 'error' ? theme.glyph.cross : theme.glyph.ring
  const text = state.status === 'unknown' ? 'on' : state.status
  return <Text color={color}>{`${glyph} ${text}`.padEnd(13)}</Text>
}

function LiveLine({ state }: { state: AdapterLiveState }) {
  const theme = useTheme()
  const color = state.status === 'connected' ? theme.color.success : state.status === 'error' ? theme.color.error : theme.color.warn
  const glyph = state.status === 'connected' ? theme.glyph.dot : state.status === 'error' ? theme.glyph.cross : theme.glyph.ring
  return <Text color={color} wrap="wrap">{glyph} {state.status}{state.error ? `: ${state.error}` : ''}</Text>
}
