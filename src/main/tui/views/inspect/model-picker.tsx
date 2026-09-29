// /model: change the selected agent › loop's model. main → the agent config's
// model (re-read, only model.provider / model.model_id change, then PUT);
// an inner loop → its own model override (PATCH the loop), or back to
// inheriting the agent's model. No argument opens a two-step picker:
// provider (with sign-in / key state) → model (type to filter).

import { useEffect, useMemo, useState } from 'react'
import { Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { List } from '../../ui/List'
import { Modal } from '../../ui/Modal'
import { truncate } from '../../ui/text'
import { MAIN_LOOP } from '../../api/types'
import type { TuiStore } from '../../state/store'
import type { TuiState } from '../../state/types'
import type { OverlayProps } from '../types'

export const MODEL_OVERLAY = 'inspect.model'

export interface ProviderChoice {
  id: string
  name: string
  type: string
  /** `signed in`, `not signed in`, `key set`, `no key`, `local`. */
  access: string
  ready: boolean
}

/** Providers as the picker lists them, with whether the daemon can use each now. */
export function providerChoices(providers: Array<Record<string, unknown>>, auth: TuiState['auth']): ProviderChoice[] {
  return providers.map(p => {
    const type = String(p.type ?? '')
    const id = String(p.id ?? '')
    const name = String(p.name ?? id)
    if (type === 'chatgpt-subscription' || type === 'grok-subscription') {
      const signedIn = (type === 'chatgpt-subscription' ? auth?.chatgpt : auth?.grok) as { authenticated?: boolean } | undefined
      return { id, name, type, access: signedIn?.authenticated ? 'signed in' : 'not signed in (/login)', ready: !!signedIn?.authenticated }
    }
    if (p.hasApiKey === true) return { id, name, type, access: 'key set', ready: true }
    const base = String(p.baseUrl ?? '')
    if (/localhost|127\.0\.0\.1/.test(base)) return { id, name, type, access: 'local', ready: true }
    return { id, name, type, access: 'no key', ready: false }
  })
}

/** Model ids from `GET /runtime/models` (strings, or objects with id / name). */
export function modelIds(models: unknown[]): string[] {
  return models.map(m => (typeof m === 'string' ? m : m && typeof m === 'object' ? String((m as Record<string, unknown>).id ?? (m as Record<string, unknown>).name ?? '') : '')).filter(Boolean)
}

/** `[provider/]model`: the prefix is a provider only when it names one (model ids contain `/` too). */
export function parseModelArg(arg: string, providers: ProviderChoice[]): { provider?: string; model: string } {
  const at = arg.indexOf('/')
  if (at > 0) {
    const head = arg.slice(0, at).toLowerCase()
    const match = providers.find(p => p.id.toLowerCase() === head || p.name.toLowerCase() === head || p.type.toLowerCase() === head)
    if (match) return { provider: match.id, model: arg.slice(at + 1) }
  }
  return { model: arg }
}

/** The model that runs (agent, loop) now: the loop's override, else the agent's. */
export function currentModel(state: TuiState, agentId: string, loop: string): { provider?: string; model?: string; inherited: boolean } {
  const agent = state.agents[agentId]
  const own = loop === MAIN_LOOP ? undefined : agent?.loops?.find(l => l.info.name === loop)?.info.config?.model
  const m = own ?? agent?.config?.model
  return { provider: m?.provider, model: m?.model_id, inherited: loop !== MAIN_LOOP && !own }
}

const label = (state: TuiState, agentId: string) => state.agents[agentId]?.summary.handle || state.agents[agentId]?.summary.name || agentId

/** Apply a model to (agent, loop); toasts the result. `model: null` = an inner loop inherits again. */
export async function applyModel(store: TuiStore, agentId: string, loop: string, choice: { provider: string; model: string } | null): Promise<boolean> {
  const { actions } = store
  const who = `${label(store.getState(), agentId)}${loop === MAIN_LOOP ? '' : ` › ${loop}`}`
  if (loop !== MAIN_LOOP) {
    if (!choice) {
      const result = await actions.run('Model', c => c.updateLoop(agentId, loop, { model: null }))
      if (!result) return false
      await actions.refreshLoops(agentId)
      actions.toast(`${who} inherits the agent’s model again`, 'success')
      return true
    }
    const state = store.getState()
    const base = state.agents[agentId]?.loops?.find(l => l.info.name === loop)?.info.config?.model ?? state.agents[agentId]?.config?.model
    const result = await actions.run('Model', c => c.updateLoop(agentId, loop, { model: { ...(base ?? {}), provider: choice.provider, model_id: choice.model } as NonNullable<typeof base> }))
    if (!result) return false
    await actions.refreshLoops(agentId)
    actions.toast(`${who} now runs ${choice.provider}/${choice.model}`, 'success')
    return true
  }
  if (!choice) { actions.toast('main always has a model: pick one', 'warn'); return false }
  // Re-read right before writing so a concurrent config change is not undone; only the model moves.
  const fresh = await actions.run('Model', c => c.config(agentId))
  if (!fresh) return false
  const next = { ...fresh.config, model: { ...fresh.config.model, provider: choice.provider, model_id: choice.model } }
  const saved = await actions.run('Model', c => c.putConfig(agentId, next))
  if (!saved) return false
  await actions.loadConfig(agentId)
  actions.toast(`${who} now runs ${choice.provider}/${choice.model}`, 'success')
  return true
}

type Step = { kind: 'provider' } | { kind: 'model'; provider: ProviderChoice }

/** The /model picker: provider, then model. Esc steps back, then closes. */
export function ModelOverlay({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const agentId = String(overlay.props?.agentId ?? '')
  const loop = String(overlay.props?.loop ?? MAIN_LOOP)
  const current = currentModel(store.getState(), agentId, loop)
  const [providers, setProviders] = useState<ProviderChoice[] | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'provider' })
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    store.client.providers().then(
      d => {
        const list = providerChoices(d.providers as unknown as Array<Record<string, unknown>>, store.getState().auth)
        setProviders(list)
        setIndex(Math.max(0, list.findIndex(p => p.id === current.provider)) + (loop === MAIN_LOOP ? 0 : 1))
      },
      err => setError(err instanceof Error ? err.message : String(err)),
    )
  }, [])

  const openProvider = (provider: ProviderChoice) => {
    setStep({ kind: 'model', provider })
    setModels(null)
    setQuery('')
    setError(null)
    store.client.models(provider.id, agentId).then(
      d => {
        const ids = modelIds(d.models)
        setModels(ids)
        setIndex(Math.max(0, ids.indexOf(current.provider === provider.id ? current.model ?? '' : '')))
      },
      err => { setModels([]); setError(err instanceof Error ? err.message : String(err)) },
    )
  }

  const inheritRow = loop === MAIN_LOOP ? [] : [{ id: '', name: 'inherit', type: '', access: 'use the agent’s model', ready: true }]
  const providerRows: ProviderChoice[] = [...inheritRow, ...(providers ?? [])]
  const shownModels = useMemo(() => (models ?? []).filter(m => m.toLowerCase().includes(query.toLowerCase())), [models, query])

  const apply = (choice: { provider: string; model: string } | null) => {
    close()
    void applyModel(store, agentId, loop, choice)
  }

  // Registered after the List (effects run child first), so it sees keys first:
  // letters filter the model list; ↑↓ Enter PgUp PgDn go to the List.
  useKeys((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      if (step.kind === 'model' && !(key.ctrl && input === 'c')) {
        if (query) { setQuery(''); return true }
        setStep({ kind: 'provider' })
        setIndex(Math.max(0, providerRows.findIndex(p => p.id === step.provider.id)))
        return true
      }
      close()
      return true
    }
    if (step.kind !== 'model' || key.ctrl || key.meta) return false
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setIndex(0); return true }
    if (key.leftArrow) { setStep({ kind: 'provider' }); return true }
    // eslint-disable-next-line no-control-regex
    if (input && !/[\u0000-\u001f\u007f]/.test(input) && !key.return && !key.tab) { setQuery(q => q + input); setIndex(0); return true }
    return false
  }, { layer: 'overlay' })

  const dialogWidth = Math.max(36, Math.min(width - 4, 80))
  const inner = dialogWidth - 4
  const who = `${label(store.getState(), agentId)}${loop === MAIN_LOOP ? '' : ` › ${loop}`}`
  const now = current.model ? `${current.provider ?? '?'}/${current.model}${current.inherited ? ' (inherited)' : ''}` : 'none'

  if (step.kind === 'provider') {
    return (
      <Modal title={`Model ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={[{ keys: 'up down', label: 'move' }, { keys: 'enter', label: 'choose' }, { keys: 'esc', label: 'cancel' }]}>
        <Text color={theme.color.muted} wrap="truncate-end">now {now} {theme.glyph.sep} pick a provider</Text>
        {error ? <Text color={theme.color.error} wrap="wrap">Providers: {error}</Text> : null}
        {!providers && !error ? <Text color={theme.color.dim}>Loading providers…</Text> : (
          <List
            items={providerRows}
            getKey={p => p.id || 'inherit'}
            height={Math.min(10, Math.max(1, providerRows.length))}
            width={inner}
            keyLayer="overlay"
            selectedIndex={Math.min(index, Math.max(0, providerRows.length - 1))}
            onSelectedIndexChange={setIndex}
            onSubmit={p => (p.id ? openProvider(p) : apply(null))}
            emptyText="No providers registered with the daemon (Studio settings)."
            renderItem={(p, { selected }) => (
              <Text wrap="truncate-end" inverse={theme.mono && selected}>
                <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
                <Text bold={selected} color={theme.color.text}>{truncate(p.name, 26).padEnd(26)}</Text>
                <Text color={p.ready ? theme.color.success : theme.color.warn}> {p.access}</Text>
                {p.id && p.id === current.provider ? <Text color={theme.color.accent}>  (current)</Text> : null}
                {!p.id && current.inherited ? <Text color={theme.color.accent}>  (current)</Text> : null}
              </Text>
            )}
          />
        )}
      </Modal>
    )
  }

  return (
    <Modal title={`Model ${theme.glyph.sep} ${who} ${theme.glyph.sep} ${step.provider.name}`} width={dialogWidth} hints={[{ keys: 'up down', label: 'move' }, { keys: 'enter', label: 'use' }, { keys: 'a-z', label: 'filter' }, { keys: 'esc', label: 'back' }]}>
      <Text wrap="truncate-end">
        <Text color={theme.color.muted}>filter </Text>
        <Text color={theme.color.text}>{query}</Text>
        <Text color={theme.color.accent}>_</Text>
        <Text color={theme.color.dim}>  {models ? `${shownModels.length} of ${models.length}` : 'loading…'}</Text>
      </Text>
      {error ? <Text color={theme.color.error} wrap="wrap">Models: {error}</Text> : null}
      {models ? (
        <List
          items={shownModels}
          getKey={m => m}
          height={Math.min(12, Math.max(1, shownModels.length))}
          width={inner}
          keyLayer="overlay"
          selectedIndex={Math.min(index, Math.max(0, shownModels.length - 1))}
          onSelectedIndexChange={setIndex}
          onSubmit={m => apply({ provider: step.provider.id, model: m })}
          emptyText={query ? `No model matches "${query}".` : 'This provider lists no models.'}
          renderItem={(m, { selected }) => (
            <Text wrap="truncate-end" inverse={theme.mono && selected}>
              <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
              <Text bold={selected} color={theme.color.text}>{m}</Text>
              {step.provider.id === current.provider && m === current.model ? <Text color={theme.color.accent}>  (current)</Text> : null}
            </Text>
          )}
        />
      ) : null}
    </Modal>
  )
}
