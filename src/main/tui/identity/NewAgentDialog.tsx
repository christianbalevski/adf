// New agent wizard: name, template, optional provider/model, start now.
// `POST /agents/create` does what Studio's "new agent" does (sealed identity,
// owner stamps, reviewed, tracked, loaded). On success the agent is selected
// and its chat opens. 409 identity_not_ready routes to the identity dialog,
// which reopens this wizard once the identity is ready.

import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useStore } from '../state/store'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { Form, type FieldSpec, type FormValues } from '../views/loops/Form'
import type { AgentTemplate, TemplateListResult } from '../api/types'
import type { OverlayProps } from '../views/types'
import { IDENTITY_OVERLAY, NEW_AGENT_OVERLAY, identityErrorText, type IdentityOverlayProps } from './model'

const TEMPLATE_DEFAULT = ''

interface ProviderOption { id: string; label: string }

export function NewAgentDialog({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const props = (overlay.props ?? {}) as { name?: string }
  const dialogWidth = Math.max(50, Math.min(width - 4, 84))

  const [list, setList] = useState<TemplateListResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [models, setModels] = useState<string[]>([])
  const [values, setValues] = useState<FormValues>({ name: props.name ?? '', template: '', provider: TEMPLATE_DEFAULT, model: '', start: true })
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toIdentity = (reason: string) => {
    close()
    const next: IdentityOverlayProps = { mode: 'status', then: NEW_AGENT_OVERLAY, reason, ...(typeof values.name === 'string' && values.name.trim() ? { name: values.name.trim() } : {}) }
    store.actions.pushOverlay({ kind: IDENTITY_OVERLAY, props: { ...next } })
  }

  useEffect(() => {
    let live = true
    void (async () => {
      const result = await store.actions.listTemplates()
      if (!live) return
      if (!result.ok) {
        if (result.code === 'identity_not_ready') { toIdentity('Agents are sealed under your owner identity: set it up first.'); return }
        setLoadError(result.error)
        return
      }
      setList(result.value)
      setValues(v => ({ ...v, template: v.template || result.value.defaultId }))
    })()
    void store.actions.run('Providers', c => c.providers()).then(p => {
      if (!live || !p) return
      setProviders(p.providers.map(x => ({ id: x.id, label: x.name && x.name !== x.id ? `${x.name} (${x.id})` : x.id })))
    })
    return () => { live = false }
  }, [])

  const template: AgentTemplate | undefined = list?.templates.find(t => t.id === values.template)
  const provider = typeof values.provider === 'string' ? values.provider : ''

  useEffect(() => {
    setModels([])
    if (!provider) return
    let live = true
    void store.client.models(provider).then(r => {
      if (!live) return
      setModels((r.models ?? []).map(m => (typeof m === 'string' ? m : typeof m === 'object' && m && 'id' in m ? String((m as { id: unknown }).id) : String(m))))
    }).catch(() => { /* free-text model id still works */ })
    return () => { live = false }
  }, [provider])

  const fields: FieldSpec[] = useMemo(() => [
    { kind: 'text', key: 'name', label: 'Name', placeholder: 'empty = a generated name', hint: 'The file name: <name>.adf in the agents folder' },
    {
      kind: 'choice',
      key: 'template',
      label: 'Template',
      options: (list?.templates ?? []).map(t => ({ value: t.id, label: `${t.name}${t.id === list?.defaultId ? ' (default)' : ''}${t.reviewed ? '' : ' (not reviewed)'}` })),
      hint: '←→ pick a template',
    },
    {
      kind: 'choice',
      key: 'provider',
      label: 'Provider',
      options: [{ value: TEMPLATE_DEFAULT, label: `template's${template?.modelProvider ? ` (${template.modelProvider})` : ''}` }, ...providers.map(p => ({ value: p.id, label: p.label }))],
      hint: '←→ optional: override the template’s provider',
    },
    {
      kind: 'combo',
      key: 'model',
      label: 'Model',
      options: models,
      placeholder: provider ? 'provider default' : `template's${template?.modelId ? ` (${template.modelId})` : ''}`,
      hint: provider ? `←→ pick a ${provider} model or type any id` : 'optional: needs a provider override',
      readOnly: !provider,
    },
    { kind: 'bool', key: 'start', label: 'Start now', hint: 'Start the agent right after creating it' },
  ], [list, providers, models, provider, template])

  const submit = async () => {
    if (busy || !list) return
    setErrors({}); setFormError(null)
    if (template && !template.reviewed) { setErrors({ template: 'This template came from someone else and is not reviewed. Review it in ADF Studio, or pick another.' }); return }
    const name = typeof values.name === 'string' ? values.name.trim() : ''
    const model = provider && typeof values.model === 'string' ? values.model.trim() : ''
    setBusy(true)
    const result = await store.actions.createAgent({
      ...(name ? { name } : {}),
      ...(values.template ? { template: String(values.template) } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      start: values.start === true,
    })
    setBusy(false)
    if (result.ok) {
      close()
      const id = result.value.agentId
      if (store.getState().agents[id]) {
        store.actions.selectAgent(id)
        store.actions.setView('chat')
      }
      return
    }
    switch (result.code) {
      case 'identity_not_ready':
        toIdentity('Agents are sealed under your owner identity: set it up first.')
        return
      case 'name_taken':
        setErrors({ name: 'An agent with that name already exists in the folder. Pick another.' })
        return
      case 'template_missing':
      case 'template_unreviewed':
        setErrors({ template: result.error })
        return
      default:
        setFormError(identityErrorText(result.code, result.error))
    }
  }

  const warning = template?.warning
  const about = template?.templateDescription ?? template?.description

  return (
    <Modal
      title="New agent"
      width={dialogWidth}
      onClose={list ? undefined : close /* the form owns Esc once it exists (asks before dropping edits) */}
      hints={busy ? [] : [{ keys: 'enter', label: 'next / create' }, { keys: 'ctrl+s', label: 'create' }, { keys: 'esc', label: 'cancel' }]}
    >
      {loadError ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} Templates: {loadError}</Text> : null}
      {!list && !loadError ? <Spinner label="reading templates…" /> : null}
      {list ? (
        <>
          <Form
            fields={fields}
            values={values}
            onChange={v => { setValues(v); setFormError(null) }}
            errors={errors}
            onSubmit={() => { void submit() }}
            onCancel={close}
            width={dialogWidth - 4}
            height={Math.max(6, Math.min(12, height - 12))}
            active={!busy}
            cancelLabel="close"
          />
          <Box flexDirection="column" marginTop={1}>
            {about ? <Text color={theme.color.dim} wrap="wrap">{about}</Text> : null}
            {warning ? <Text color={theme.color.warn} wrap="wrap">{theme.glyph.warn} {warning}</Text> : null}
            <Text color={theme.color.dim} wrap="truncate-end">folder {list.defaultDirectory}</Text>
          </Box>
        </>
      ) : null}
      {busy ? <Spinner label="creating…" /> : null}
      {formError ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {formError}</Text> : null}
    </Modal>
  )
}
