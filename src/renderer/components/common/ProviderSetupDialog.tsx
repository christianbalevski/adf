import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog } from './Dialog'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentStore } from '../../stores/agent.store'
import { PROVIDER_TYPES, type ProviderType } from '../../../shared/constants/adf-defaults'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { Button, Select, TextInput } from '../ui'

type Phase = 'choose' | 'model'

const KEY_TYPES: ProviderType[] = ['anthropic', 'openai', 'openrouter', 'openai-compatible']

function generateProviderId(): string {
  return 'custom:' + Math.random().toString(36).slice(2, 8)
}

function meta(type: ProviderType) {
  return PROVIDER_TYPES.find((p) => p.type === type) ?? PROVIDER_TYPES[0]
}

/**
 * Provider at the moment of need. Mounted once in AppShell; opens whenever a
 * start is parked on `providerSetupRequest`. Sign-in providers first, API
 * key second. On success the new provider is saved to app settings (and
 * becomes the default when there was none), the blocked agent's model is
 * pointed at it, and the request resolves true so the start retries.
 *
 * The key lives in app settings, never in the agent file — same rule as the
 * Providers tab. Escape/close resolves false: nothing was written, nothing
 * pretends to be connected.
 */
export function ProviderSetupDialog() {
  const request = useAppStore((s) => s.providerSetupRequest)
  const resolveProviderSetup = useAppStore((s) => s.resolveProviderSetup)
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const agentName = useAgentStore((s) => s.config?.name)

  const [phase, setPhase] = useState<Phase>('choose')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyType, setKeyType] = useState<ProviderType>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [grokDevice, setGrokDevice] = useState<{ userCode: string; verificationUri: string } | null>(null)
  const [saved, setSaved] = useState<ProviderConfig | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [modelId, setModelId] = useState('')

  const open = request !== null

  // Fresh sheet for every request — keyed on the request object, so a second
  // request replacing a first one gets a clean sheet too.
  useEffect(() => {
    if (!request) return
    setPhase('choose')
    setBusy(null)
    setError(null)
    setApiKey('')
    setBaseUrl('')
    setGrokDevice(null)
    setSaved(null)
    setModels([])
    setModelId('')
  }, [request])

  // Grok is a device-code flow: poll until the browser side approves.
  useEffect(() => {
    if (!grokDevice) return
    const timer = setInterval(() => {
      window.adfApi?.grokAuthStatus().then((status) => {
        if (status.authenticated) {
          setGrokDevice(null)
          void saveProvider('grok-subscription', { apiKey: '', baseUrl: '' })
        } else if (status.flowError || status.flowPending === false) {
          setGrokDevice(null)
          setBusy(null)
          setError(status.flowError ?? 'Sign-in did not complete')
        }
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grokDevice])

  const close = useCallback((connected: boolean) => {
    // A pending device-code sign-in is abandoned, not left running.
    if (grokDevice) {
      setGrokDevice(null)
      setBusy(null)
      void window.adfApi.grokAuthLogout().catch(() => {})
    }
    resolveProviderSetup(connected)
  }, [grokDevice, resolveProviderSetup])

  /**
   * Persist the provider, probe it, and move to model choice. A failed
   * probe keeps the provider out of settings — a half-configured entry
   * would only move the same failure to the next start.
   */
  const saveProvider = useCallback(async (type: ProviderType, fields: { apiKey: string; baseUrl: string }) => {
    setBusy(type)
    setError(null)
    try {
      const settings = await window.adfApi.getSettings()
      const existing = settings.providers ?? []
      const previousDefault = settings.defaultProviderId
      const provider: ProviderConfig = {
        id: generateProviderId(),
        type,
        name: meta(type).label,
        baseUrl: fields.baseUrl,
        apiKey: fields.apiKey,
        defaultModel: '',
        params: []
      }
      const next = [...existing, provider]
      await window.adfApi.setSettings({
        providers: next,
        ...(settings.defaultProviderId ? {} : { defaultProviderId: provider.id })
      })
      const probe = await window.adfApi.testProvider(provider.id, true)
      if (probe.status !== 'ok') {
        // Roll back off the current settings, not the copy read before the
        // write — anything saved in between (another window, another
        // provider) stays. The default pointer goes back to what it was;
        // '' is how settings spells "no default".
        const current = await window.adfApi.getSettings()
        await window.adfApi.setSettings({
          providers: (current.providers ?? []).filter((p) => p.id !== provider.id),
          defaultProviderId: previousDefault ?? ''
        })
        setError(probe.status === 'failed'
          ? `${meta(type).label} rejected these credentials.`
          : `${meta(type).label} did not answer — check the key and base URL.`)
        return
      }
      let list: string[] = []
      try {
        const res = await window.adfApi.listModels(provider.id)
        list = res.models ?? []
      } catch { /* a provider without a model list still works with a typed id */ }
      setSaved(provider)
      setModels(list)
      setModelId(list[0] ?? '')
      setPhase('model')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const signInChatGpt = useCallback(async () => {
    setBusy('chatgpt-subscription')
    setError(null)
    try {
      const result = await window.adfApi.chatgptAuthStart()
      if (!result.success) {
        setError(result.error ?? 'Sign-in did not complete')
        setBusy(null)
        return
      }
      await saveProvider('chatgpt-subscription', { apiKey: '', baseUrl: '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }, [saveProvider])

  const signInGrok = useCallback(async () => {
    setBusy('grok-subscription')
    setError(null)
    try {
      const result = await window.adfApi.grokAuthStart()
      if (result.success && result.userCode && result.verificationUri) {
        setGrokDevice({ userCode: result.userCode, verificationUri: result.verificationUri })
      } else {
        setError(result.error ?? 'Sign-in did not start')
        setBusy(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }, [])

  const connectKey = useCallback(async () => {
    const needsKey = keyType !== 'openai-compatible'
    if (needsKey && !apiKey.trim()) {
      setError('Paste an API key first.')
      return
    }
    if (keyType === 'openai-compatible' && !baseUrl.trim()) {
      setError('An OpenAI-compatible provider needs its base URL.')
      return
    }
    await saveProvider(keyType, { apiKey: apiKey.trim(), baseUrl: baseUrl.trim() })
  }, [apiKey, baseUrl, keyType, saveProvider])

  /** Write the model choice to the provider's default and the blocked agent's config, then resolve. */
  const finish = useCallback(async () => {
    if (!saved) return
    const chosen = modelId.trim()
    if (!chosen) {
      setError('Pick or type a model id.')
      return
    }
    setBusy('finish')
    setError(null)
    try {
      const settings = await window.adfApi.getSettings()
      const providers = (settings.providers ?? []).map((p) => (p.id === saved.id ? { ...p, defaultModel: chosen } : p))
      await window.adfApi.setSettings({ providers })

      // Point the blocked agent at it. The open agent saves through its
      // workspace like any config edit; a background one is written by path.
      const foreground = useDocumentStore.getState().filePath
      if (request?.filePath && request.filePath === foreground) {
        const config = await window.adfApi.getAgentConfig()
        if (config) {
          const updated = { ...config, model: { ...config.model, provider: saved.id, model_id: chosen } }
          await window.adfApi.setAgentConfig(updated)
          useAgentStore.getState().setConfig(updated)
        }
      } else if (request?.filePath) {
        const r = await window.adfApi.setAgentModelForFile(request.filePath, { provider: saved.id, model_id: chosen })
        if (!r.success) {
          setError(r.error ?? 'Could not update the agent')
          return
        }
      }
      close(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [close, modelId, request?.filePath, saved])

  const title = phase === 'model' ? 'Model' : 'Connect a provider'
  const reasonLine = useMemo(() => {
    const who = agentName ?? 'This agent'
    return request?.reason === 'provider_unconfigured'
      ? `${who}'s provider has no API key on this computer.`
      : `${who}'s model names a provider that is not configured on this computer.`
  }, [agentName, request?.reason])

  return (
    <Dialog
      open={open}
      onClose={() => close(false)}
      title={title}
      // Waiting on the browser half of a device-code sign-in is not a busy
      // state the user has to sit through: Escape and Cancel abort it.
      preventClose={busy !== null && !grokDevice}
      lightDismiss={false}
    >
      {phase === 'choose' ? (
        <div className="space-y-4">
          <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
            {reasonLine} Credentials are stored in app settings, not in the agent file.
          </p>

          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--adf-ui-text-subtle)]">Sign in</div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                onClick={signInChatGpt}
                loading={busy === 'chatgpt-subscription'}
                disabled={busy !== null}
                className="w-full"
              >
                ChatGPT
              </Button>
              <Button
                variant="primary"
                onClick={signInGrok}
                loading={busy === 'grok-subscription' && !grokDevice}
                disabled={busy !== null}
                className="w-full"
              >
                Grok
              </Button>
            </div>
            {grokDevice && (
              <div className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-3 text-[12px]">
                <div className="text-[var(--adf-ui-text-muted)]">Your browser opened. Confirm this code there:</div>
                <div className="mt-1 font-mono text-lg tracking-widest">{grokDevice.userCode}</div>
                <div className="mt-1 text-[11px] text-[var(--adf-ui-text-subtle)]">{grokDevice.verificationUri}</div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--adf-ui-text-subtle)]">API key</div>
            <Select
              aria-label="Provider"
              value={keyType}
              onChange={(e) => { setKeyType(e.target.value as ProviderType); setError(null) }}
              disabled={busy !== null}
              className="text-xs"
            >
              {KEY_TYPES.map((t) => (
                <option key={t} value={t}>{meta(t).label}</option>
              ))}
            </Select>
            {keyType === 'openai-compatible' && (
              <TextInput
                aria-label="Base URL"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:1234/v1"
                disabled={busy !== null}
                className="text-xs"
              />
            )}
            <div className="flex gap-2">
              <TextInput
                aria-label="API key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={meta(keyType).placeholder.apiKey}
                disabled={busy !== null}
                onKeyDown={(e) => { if (e.key === 'Enter') void connectKey() }}
                className="flex-1 text-xs"
              />
              <Button onClick={connectKey} loading={busy === keyType} disabled={busy !== null}>
                Connect
              </Button>
            </div>
          </div>

          {error && <p className="text-[12px] text-[var(--adf-ui-danger)]">{error}</p>}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              className="text-[11px] text-[var(--adf-ui-text-muted)] hover:text-[var(--adf-ui-text)]"
              onClick={() => { close(false); openSettingsAt('providers') }}
              disabled={busy !== null}
            >
              Provider settings…
            </button>
            <Button variant="ghost" onClick={() => close(false)} disabled={busy !== null && !grokDevice}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[12px] text-[var(--adf-ui-text-muted)]">
            Default model for {saved ? meta(saved.type).label : 'the provider'}. Also set as {agentName ?? 'this agent'}'s model.
          </p>
          {models.length > 0 ? (
            <Select aria-label="Model" value={models.includes(modelId) ? modelId : '__custom__'} onChange={(e) => {
              if (e.target.value !== '__custom__') setModelId(e.target.value)
              else setModelId('')
            }} className="text-xs">
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__custom__">Type a model id…</option>
            </Select>
          ) : null}
          {(models.length === 0 || !models.includes(modelId)) && (
            <TextInput
              aria-label="Model id"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder={saved ? meta(saved.type).placeholder.model : 'Model id'}
              onKeyDown={(e) => { if (e.key === 'Enter') void finish() }}
              className="text-xs"
            />
          )}
          {error && <p className="text-[12px] text-[var(--adf-ui-danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => close(false)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button variant="primary" onClick={finish} loading={busy === 'finish'} disabled={busy !== null}>
              Save and start
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
