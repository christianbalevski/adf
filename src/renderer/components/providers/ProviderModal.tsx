import { useMemo, useState } from 'react'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import {
  PROVIDER_CATALOG,
  PROVIDER_CATALOG_GROUPS,
  catalogEntryForProvider,
  isSubscriptionType,
  providerTypeHint,
  type ProviderCatalogEntry,
} from '../../../shared/constants/provider-catalog'
import { Dialog } from '../common/Dialog'
import { BrandMark } from '../common/BrandMark'
import { Button, Select, TextInput } from '../ui'
import { ProviderAgentOverrides, ParamsEditor } from './ProviderAgentOverrides'
import { providerDotClass, providerStatusLabel, type ProviderTestStatus } from './provider-status'

export interface SubscriptionAuthState {
  authenticated: boolean
  email?: string
  loading: boolean
  /** Grok device-code flow in progress */
  device?: { userCode: string; verificationUri: string } | null
  flowError?: string
  signIn: () => void
  signOut: () => void
}

export interface ModelListState {
  models: string[]
  error?: string
  loading?: boolean
}

interface ProviderModalProps {
  open: boolean
  onClose: () => void
  /** null = choose a provider to add */
  provider: ProviderConfig | null
  isDefault: boolean
  status?: ProviderTestStatus
  onPick: (entry: ProviderCatalogEntry) => void
  onUpdate: (patch: Partial<ProviderConfig>) => void
  onRemove: () => void
  onMakeDefault: () => void
  onTest: () => void
  models?: ModelListState
  onFetchModels: () => void
  chatgpt: SubscriptionAuthState
  grok: SubscriptionAuthState
  /** Agents whose .adf carries a copy of this provider (keyed or not). */
  onCarrierCountChange?: (count: number) => void
}

export function ProviderModal(props: ProviderModalProps) {
  const { open, onClose, provider } = props
  const entry = provider ? catalogEntryForProvider(provider) : undefined
  const title = provider ? (provider.name || entry?.label || 'Provider') : 'Add a provider'

  return (
    <Dialog open={open} onClose={onClose} title={title} wide lightDismiss={!provider}>
      {provider ? <ProviderForm key={provider.id} {...props} provider={provider} entry={entry} /> : <ProviderPicker onPick={props.onPick} />}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

function ProviderPicker({ onPick }: { onPick: (entry: ProviderCatalogEntry) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () => (q ? PROVIDER_CATALOG.filter((e) => `${e.label} ${e.description} ${e.type}`.toLowerCase().includes(q)) : PROVIDER_CATALOG),
    [q],
  )

  return (
    <div className="space-y-3">
      <TextInput
        autoFocus
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search providers…"
        aria-label="Search providers"
      />
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {PROVIDER_CATALOG_GROUPS.map((group) => {
          const entries = visible.filter((e) => e.group === group.id)
          if (entries.length === 0) return null
          return (
            <section key={group.id}>
              <div className="mb-1.5 flex items-baseline gap-2">
                <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--adf-ui-text-muted)]">{group.label}</h3>
                <span className="text-[11px] text-[var(--adf-ui-text-subtle)]">{group.hint}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {entries.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    onClick={() => onPick(e)}
                    className="flex items-start gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] p-2.5 text-left transition-colors hover:border-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
                  >
                    <BrandMark iconKey={e.iconKey} label={e.label} size={28} />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium text-[var(--adf-ui-text)]">{e.label}</span>
                      <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-4 text-[var(--adf-ui-text-muted)]">{e.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
        {visible.length === 0 && (
          <p className="py-6 text-center text-[12px] text-[var(--adf-ui-text-subtle)]">
            Nothing matches. Any endpoint that speaks the OpenAI API works with the OpenAI-compatible tile.
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-[10.5px] text-[var(--adf-ui-text-subtle)]">{hint}</p>}
    </div>
  )
}

function ProviderForm({
  provider, entry, isDefault, status, onUpdate, onRemove, onMakeDefault, onTest, onClose,
  models, onFetchModels, chatgpt, grok, onCarrierCountChange,
}: ProviderModalProps & { provider: ProviderConfig; entry?: ProviderCatalogEntry }) {
  const subscription = isSubscriptionType(provider.type)
  const auth = provider.type === 'chatgpt-subscription' ? chatgpt : provider.type === 'grok-subscription' ? grok : null
  const [customModel, setCustomModel] = useState(false)
  const modelList = models?.models ?? []
  const listMode = modelList.length > 0 && !customModel
  // Catalog base URLs carry one uppercase placeholder (YOUR_ACCOUNT_ID, YOUR_RESOURCE).
  const baseUrlPlaceholder = provider.baseUrl.match(/YOUR_[A-Z0-9_]+/)?.[0]

  return (
    <div className="space-y-4">
      {/* Identity + status */}
      <div className="flex items-center gap-3">
        <BrandMark iconKey={entry?.iconKey} label={entry?.label ?? provider.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span className="flex items-center gap-1.5 text-[var(--adf-ui-text-muted)]">
              <span className={`h-2 w-2 shrink-0 rounded-full ${providerDotClass(status)}`} />
              {providerStatusLabel(status)}
            </span>
            {isDefault ? (
              <span className="rounded bg-[var(--adf-ui-warning-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--adf-ui-warning)]">Default for new agents</span>
            ) : (
              <button type="button" onClick={onMakeDefault} className="text-[11px] text-[var(--adf-ui-accent)] underline-offset-2 hover:underline">Make default for new agents</button>
            )}
          </div>
          <p className="mt-0.5 text-[10.5px] text-[var(--adf-ui-text-subtle)]">{providerTypeHint(provider.type)}</p>
        </div>
        <Button variant="secondary" size="compact" onClick={onTest} disabled={status === 'testing'} loading={status === 'testing'}>
          {status === 'testing' ? 'Testing…' : 'Test'}
        </Button>
      </div>

      {/* App default */}
      <section className="space-y-2.5">
        <div>
          <div className="text-[13px] font-medium text-[var(--adf-ui-text)]">App values</div>
          <p className="mt-0.5 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">Used by every agent on this provider, unless the agent carries its own copy.</p>
        </div>
        <Field label="Name">
          <TextInput aria-label="Provider name" type="text" value={provider.name} onChange={(e) => onUpdate({ name: e.target.value })} placeholder={entry?.label} />
        </Field>
        {provider.type === 'openai-compatible' && (
          <Field
            label="Base URL"
            hint={baseUrlPlaceholder
              ? <span className="text-[var(--adf-ui-warning)]">Replace {baseUrlPlaceholder} with your own value.</span>
              : 'The root the /chat/completions path is appended to.'}
          >
            <TextInput aria-label="Base URL" type="text" value={provider.baseUrl} onChange={(e) => onUpdate({ baseUrl: e.target.value })} placeholder={entry?.baseUrl ?? 'http://localhost:1234/v1'} className="font-mono text-[12px]" />
          </Field>
        )}

        {auth ? (
          <SubscriptionAuth auth={auth} label={entry?.label ?? provider.name} />
        ) : (
          <Field
            label="API key"
            hint={entry?.keysUrl ? <ExternalLink href={entry.keysUrl}>Get a key ↗</ExternalLink> : entry?.keyOptional ? 'Most local servers accept any value or none.' : undefined}
          >
            <TextInput
              aria-label="API key"
              type="password"
              value={provider.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              placeholder={entry?.keyPlaceholder ?? 'API key'}
              className="font-mono text-[12px]"
            />
          </Field>
        )}

        <Field label="Default model" hint={models?.error ? <span className="text-[var(--adf-ui-danger)]">{models.error}</span> : 'Agents can pick another model; this is the starting point.'}>
          {models?.loading ? (
            <div className="px-1 py-1.5 text-[12px] text-[var(--adf-ui-text-subtle)]">Loading models…</div>
          ) : listMode ? (
            <Select
              aria-label="Default model"
              value={modelList.includes(provider.defaultModel ?? '') ? provider.defaultModel : '__custom__'}
              onChange={(e) => {
                if (e.target.value === '__custom__') setCustomModel(true)
                else onUpdate({ defaultModel: e.target.value })
              }}
            >
              {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
              {provider.defaultModel && !modelList.includes(provider.defaultModel) && <option value={provider.defaultModel}>{provider.defaultModel} (current)</option>}
              <option value="__custom__">Type a model id…</option>
            </Select>
          ) : (
            <div className="flex gap-1.5">
              <TextInput aria-label="Default model" type="text" value={provider.defaultModel ?? ''} onChange={(e) => onUpdate({ defaultModel: e.target.value })} placeholder={entry?.modelPlaceholder ?? 'model id'} className="flex-1" />
              {modelList.length > 0 ? (
                <Button variant="ghost" size="compact" className="whitespace-nowrap" onClick={() => setCustomModel(false)}>Pick from list</Button>
              ) : (
                <Button variant="ghost" size="compact" className="whitespace-nowrap" onClick={onFetchModels}>Fetch models</Button>
              )}
            </div>
          )}
        </Field>

        <details className="group rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-2.5 py-1.5">
          <summary className="cursor-pointer select-none text-[12px] text-[var(--adf-ui-text-muted)] hover:text-[var(--adf-ui-text)]">Advanced</summary>
          <div className="mt-2 space-y-2.5">
            <Field label="Request delay (ms)" hint="Pause before each request to stay under a rate limit. 0 = none.">
              <TextInput
                aria-label="Request delay in milliseconds"
                type="number" min={0} step={100}
                value={provider.requestDelayMs ?? 0}
                onChange={(e) => onUpdate({ requestDelayMs: Math.max(0, parseInt(e.target.value) || 0) })}
              />
            </Field>
            <ParamsEditor params={provider.params ?? []} onChange={(params) => onUpdate({ params })} />
          </div>
        </details>
      </section>

      {/* Agents carrying a copy of this provider */}
      {!subscription && (
        <section className="border-t border-[var(--adf-ui-separator)] pt-3">
          <ProviderAgentOverrides provider={provider} apiKeyPlaceholder={entry?.keyPlaceholder} onCountChange={onCarrierCountChange} />
        </section>
      )}
      {subscription && (
        <p className="border-t border-[var(--adf-ui-separator)] pt-3 text-[11px] text-[var(--adf-ui-text-subtle)]">
          Subscription sign-ins are shared by every agent; no per-agent copies.
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--adf-ui-separator)] pt-3">
        <Button variant="ghost" size="compact" className="text-[var(--adf-ui-danger)]" onClick={onRemove}>Remove provider</Button>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}

function SubscriptionAuth({ auth, label }: { auth: SubscriptionAuthState; label: string }) {
  if (auth.authenticated) {
    return (
      <Field label="Account">
        <div className="flex items-center justify-between rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-success)]/40 bg-[var(--adf-ui-success-subtle)] px-2.5 py-1.5">
          <span className="text-[12px] text-[var(--adf-ui-success)]">Signed in{auth.email ? ` as ${auth.email}` : ''}</span>
          <Button variant="ghost" size="compact" className="text-[var(--adf-ui-danger)]" onClick={auth.signOut}>Sign out</Button>
        </div>
      </Field>
    )
  }
  if (auth.device) {
    return (
      <Field label="Account">
        <div className="space-y-1.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-3 py-2.5">
          <p className="text-[12px] text-[var(--adf-ui-text)]">A browser window opened. Confirm this code there:</p>
          <div className="select-all text-center font-mono text-lg tracking-widest text-[var(--adf-ui-text)]">{auth.device.userCode}</div>
          <p className="text-[10.5px] text-[var(--adf-ui-text-subtle)]">
            Waiting for approval… If no window opened, visit <span className="select-all break-all">{auth.device.verificationUri}</span> and enter the code.
          </p>
        </div>
      </Field>
    )
  }
  return (
    <Field label="Account" hint={auth.flowError ? <span className="text-[var(--adf-ui-danger)]">{auth.flowError}</span> : `Requires an eligible ${label} plan.`}>
      <Button variant="primary" className="w-full" onClick={auth.signIn} disabled={auth.loading} loading={auth.loading}>
        {auth.loading ? 'Signing in…' : `Sign in with ${label}`}
      </Button>
    </Field>
  )
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => { e.preventDefault(); window.open(href, '_blank', 'noopener,noreferrer') }}
      className="text-[var(--adf-ui-accent)] underline-offset-2 hover:underline"
    >
      {children}
    </a>
  )
}
