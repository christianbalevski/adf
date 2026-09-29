// /provider add: pick a provider (subscriptions sign in instead), fill in
// name, base URL when it needs one, the API key (masked) and an optional
// default model, then add it. The key is in this component's state only and
// is sent once, to POST /runtime/providers.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore } from '../state/store'
import { List } from '../ui/List'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { Form, type FieldSpec, type FormValues } from '../views/loops/Form'
import { MODEL_OVERLAY } from '../views/inspect/model-picker'
import { DaemonError, MAIN_LOOP, type PublicProvider } from '../api/types'
import { openAuth } from '../commands/builtin/auth'
import type { OverlayProps } from '../views/types'
import type { ProviderCatalogEntry } from '../../../shared/constants/provider-catalog'
import { identityFirst } from './open'
import {
  PROVIDER_OVERLAY,
  findProviderRow,
  keyOptional,
  keyStorageText,
  needsBaseUrl,
  providerInput,
  providerRows,
  validateProvider,
  type ProviderFormValues,
} from './provider'

type Step =
  | { kind: 'pick' }
  | { kind: 'form'; entry: ProviderCatalogEntry }
  | { kind: 'saving'; entry: ProviderCatalogEntry }
  | { kind: 'done'; provider: PublicProvider }

const GROUP_LABEL: Record<string, string> = { subscription: 'sign in', api: 'API key', local: 'local', other: 'any URL' }

export function ProviderDialog({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const rows = useMemo(providerRows, [])
  const preset = findProviderRow(String((overlay.props as { preset?: string } | undefined)?.preset ?? ''))
  const [step, setStep] = useState<Step>(preset && !preset.signIn ? { kind: 'form', entry: preset.entry } : { kind: 'pick' })
  const [index, setIndex] = useState(() => Math.max(0, rows.findIndex(r => r.entry.group === 'api')))
  // The key: component state only.
  const [values, setValues] = useState<FormValues>(() => (preset && !preset.signIn ? initialValues(preset.entry) : {}))
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const dialogWidth = Math.max(50, Math.min(width - 4, 84))
  const inner = dialogWidth - 4

  const choose = (row: (typeof rows)[number]) => {
    if (row.signIn) { close(); openAuth(store.actions, { login: row.signIn }); return }
    setValues(initialValues(row.entry)); setErrors({}); setFormError(null)
    setStep({ kind: 'form', entry: row.entry })
  }

  const text = (key: keyof ProviderFormValues) => (typeof values[key] === 'string' ? values[key] as string : '')

  const submit = async (entry: ProviderCatalogEntry) => {
    const v: ProviderFormValues = { name: text('name'), baseUrl: text('baseUrl'), apiKey: text('apiKey'), defaultModel: text('defaultModel') }
    const problems = validateProvider(entry, v)
    if (Object.keys(problems).length > 0) { setErrors(problems); return }
    setErrors({}); setFormError(null)
    setStep({ kind: 'saving', entry })
    try {
      const result = await store.client.addProvider(providerInput(entry, v))
      if (!alive.current) return
      setValues({})
      setStep({ kind: 'done', provider: result.provider })
      void store.actions.refreshAuth()
    } catch (err) {
      if (!alive.current) return
      const code = err instanceof DaemonError && err.body && typeof err.body === 'object' ? (err.body as { code?: string }).code : undefined
      if (code === 'secret_store_locked') {
        setValues({})
        close()
        identityFirst(store, PROVIDER_OVERLAY, { preset: entry.key }, 'API keys go into the daemon’s secret store, which is protected by your owner identity here: set it up or unlock it first, then add the provider again.')
        return
      }
      if (err instanceof DaemonError && err.status === 404) {
        setFormError('This daemon cannot store provider keys yet (no POST /runtime/providers): update the daemon, or add the provider in ADF Studio.')
      } else {
        setFormError(err instanceof Error ? err.message : String(err))
      }
      setStep({ kind: 'form', entry })
    }
  }

  const openModel = () => {
    const state = store.getState()
    const agentId = state.selectedAgentId
    close()
    if (agentId) store.actions.pushOverlay({ kind: MODEL_OVERLAY, props: { agentId, loop: state.selectedLoop[agentId] ?? MAIN_LOOP } })
  }

  useKeys((input, key) => {
    if (step.kind === 'saving') return true
    if (step.kind === 'done') {
      if (input === 'm' && store.getState().selectedAgentId) { openModel(); return true }
      if (key.return || key.escape || (key.ctrl && input === 'c')) { close(); return true }
      return true
    }
    if (step.kind === 'pick' && (key.escape || (key.ctrl && input === 'c'))) { close(); return true }
    return false
  }, { layer: 'overlay', active: step.kind !== 'form' })

  if (step.kind === 'pick') {
    const listHeight = Math.max(3, Math.min(rows.length, height - 9))
    return (
      <Modal title="Connect a model" width={dialogWidth} hints={[{ keys: 'up down', label: 'move' }, { keys: '/', label: 'filter' }, { keys: 'enter', label: 'choose' }, { keys: 'esc', label: 'cancel' }]}>
        <Text color={theme.color.muted} wrap="truncate-end">Subscriptions sign in; APIs take a key, stored in the daemon’s secret store.</Text>
        <List
          items={rows}
          getKey={r => r.entry.key}
          height={listHeight}
          width={inner}
          keyLayer="overlay"
          selectedIndex={index}
          onSelectedIndexChange={setIndex}
          onSubmit={choose}
          filter={(r, q) => `${r.entry.label} ${r.entry.key} ${r.entry.description}`.toLowerCase().includes(q.toLowerCase())}
          renderItem={(r, { selected }) => (
            <Text wrap="truncate-end" inverse={theme.mono && selected}>
              <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
              <Text bold={selected} color={selected ? theme.color.accent : theme.color.text}>{r.entry.label.padEnd(22)}</Text>
              <Text color={theme.color.muted}>{(GROUP_LABEL[r.entry.group] ?? '').padEnd(9)}</Text>
              <Text color={theme.color.dim}>{r.entry.description}</Text>
            </Text>
          )}
        />
      </Modal>
    )
  }

  if (step.kind === 'done') {
    const p = step.provider
    const storage = store.getState().identity?.storage
    const agentId = store.getState().selectedAgentId
    return (
      <Modal title={`${p.name} added`} width={dialogWidth} hints={[...(agentId ? [{ keys: 'm', label: 'use it: /model' }] : []), { keys: 'enter esc', label: 'close' }]}>
        <Text color={theme.color.success} wrap="wrap">{theme.glyph.check} {p.name} ({p.id}) is connected{p.defaultModel ? `, default model ${p.defaultModel}` : ''}.</Text>
        <Text color={theme.color.muted} wrap="wrap">{p.hasApiKey ? `The key is in ${keyStorageText(storage)}, never in the settings file.` : 'No key stored (a local server).'} Pick it in /model{agentId ? '' : ' once an agent is selected'}, or when you create an agent (/new).</Text>
      </Modal>
    )
  }

  const entry = step.entry
  const fields: FieldSpec[] = [
    { kind: 'text', key: 'name', label: 'Name', placeholder: `${entry.label} (default)` },
    { kind: 'text', key: 'baseUrl', label: 'Base URL', placeholder: entry.baseUrl ?? 'https://…/v1', hint: 'The server’s OpenAI-compatible root', hidden: !needsBaseUrl(entry) },
    {
      kind: 'text',
      key: 'apiKey',
      label: keyOptional(entry) ? 'API key (optional)' : 'API key',
      placeholder: entry.keyPlaceholder,
      hint: entry.keysUrl ? `Get a key: ${entry.keysUrl}` : keyOptional(entry) ? 'Usually not needed for a local server' : undefined,
      mask: true,
    },
    { kind: 'text', key: 'defaultModel', label: 'Default model', placeholder: entry.modelPlaceholder ?? 'model id (optional)', hint: 'Optional: agents can pick any model later (/model)' },
  ]

  return (
    <Modal
      title={`Connect ${entry.label}`}
      width={dialogWidth}
      hints={step.kind === 'saving' ? [] : [{ keys: 'enter', label: 'next / add' }, { keys: 'ctrl+s', label: 'add' }, { keys: 'esc', label: 'cancel' }]}
    >
      <Text color={theme.color.muted} wrap="wrap">{entry.description}</Text>
      <Box marginTop={1} flexDirection="column">
        <Form
          fields={fields}
          values={values}
          onChange={v => { setValues(v); setFormError(null) }}
          errors={errors}
          onSubmit={() => { void submit(entry) }}
          onCancel={() => { if (preset) close(); else setStep({ kind: 'pick' }) }}
          width={inner}
          height={Math.max(4, Math.min(10, height - 10))}
          active={step.kind === 'form'}
          initialField={needsBaseUrl(entry) && /YOUR_/.test(entry.baseUrl ?? '') ? 'baseUrl' : 'apiKey'}
          cancelLabel={preset ? 'close' : 'go back'}
        />
      </Box>
      {step.kind === 'saving' ? <Spinner label="storing the key in the daemon’s secret store…" /> : null}
      {formError ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {formError}</Text> : null}
    </Modal>
  )
}

function initialValues(entry: ProviderCatalogEntry): FormValues {
  return { name: '', baseUrl: needsBaseUrl(entry) ? entry.baseUrl ?? '' : '', apiKey: '', defaultModel: '' }
}
