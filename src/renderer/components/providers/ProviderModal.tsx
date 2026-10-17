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
import { editPlaceholderField } from '../../utils/placeholder-field'

export interface SubscriptionAuthState {
  authenticated: boolean
  email?: string
  loading: boolean
  /** Grok device-code flow in progress */
  device?: { userCode: string; verificationUri: string } | null
  flowError?: string
  /** False when the sign-in depends on a local tool (Claude Code) that isn't installed. */
  installed?: boolean
  installUrl?: string
  /** Installed version of the local tool, and the oldest this runtime supports. */
  version?: string
  minVersion?: string
  updateRequired?: boolean
  plan?: string
  /** Browser sign-in in progress (Claude Code). */
  flowPending?: boolean
  flowUrl?: string
  signOutHint?: string
  signIn: () => void
  signOut: () => void
  /** Paste-back for a sign-in page that shows a code instead of finishing on its own. */
  submitCode?: (code: string) => Promise<void> | void
  cancel?: () => void
  /** Look for the local tool again (after installing it). */
  recheck?: () => void
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
  /** Why the last save of this provider was refused: its edits are not saved. */
  saveError?: string
  onPick: (entry: ProviderCatalogEntry) => void
  onUpdate: (patch: Partial<ProviderConfig>) => void
  onRemove: () => void
  onMakeDefault: () => void
  onTest: () => void
  models?: ModelListState
  onFetchModels: () => void
  chatgpt: SubscriptionAuthState
  grok: SubscriptionAuthState
  claude: SubscriptionAuthState
  /** Agents whose .adf carries a copy of this provider (keyed or not). */
  onCarrierCountChange?: (count: number) => void
  /** One line above the picker and the form: why the modal opened (the at-need sheet). */
  intro?: React.ReactNode
  /**
   * Done on the form. Defaults to onClose; the at-need sheet passes its own
   * so "Done" (apply and start) and Escape/X (cancel) can differ.
   */
  onDone?: () => void
  /**
   * Done stays disabled until a default model is set, with this text as the
   * reason. The at-need sheet needs a model to hand the blocked agent.
   */
  requireDefaultModel?: string
}

export function ProviderModal(props: ProviderModalProps) {
  const { open, onClose, provider } = props
  const entry = provider ? catalogEntryForProvider(provider) : undefined
  const title = provider ? (provider.name || entry?.label || 'Provider') : 'Add a provider'

  return (
    <Dialog open={open} onClose={onClose} title={title} wide lightDismiss={!provider}>
      {props.intro && <p className="mb-3 text-[12px] text-[var(--adf-ui-text-muted)]">{props.intro}</p>}
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

/** A refused save, on the provider's row and atop its form: the edits shown are not saved. */
export function ProviderSaveError({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-danger-subtle)] px-3 py-2 text-[12px] leading-5 text-[var(--adf-ui-danger)]">
      Not saved: {message}
    </p>
  )
}

function ProviderForm({
  provider, entry, isDefault, status, saveError, onUpdate, onRemove, onMakeDefault, onTest, onClose,
  models, onFetchModels, chatgpt, grok, claude, onCarrierCountChange, onDone, requireDefaultModel,
}: ProviderModalProps & { provider: ProviderConfig; entry?: ProviderCatalogEntry }) {
  const doneBlocked = !!requireDefaultModel && !(provider.defaultModel ?? '').trim()
  const subscription = isSubscriptionType(provider.type)
  const auth = provider.type === 'chatgpt-subscription' ? chatgpt
    : provider.type === 'grok-subscription' ? grok
    : provider.type === 'claude-subscription' ? claude
    : null
  const [customModel, setCustomModel] = useState(false)
  const modelList = models?.models ?? []
  const listMode = modelList.length > 0 && !customModel
  // Catalog base URLs carry one uppercase placeholder (YOUR_ACCOUNT_ID, YOUR_RESOURCE).
  const baseUrlPlaceholder = provider.baseUrl.match(/YOUR_[A-Z0-9_]+/)?.[0]

  return (
    <div className="space-y-4">
      {saveError && <ProviderSaveError message={saveError} />}
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
        ) : provider.apiKeyStorage === 'secret-store' && provider.apiKeyStatus === 'unavailable' && !provider.apiKey ? (
          <Field label="API key">
            <div role="alert" className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/40 bg-[var(--adf-ui-warning-subtle)] px-2.5 py-1.5 text-[12px] leading-5 text-[var(--adf-ui-warning)]">
              This key was added from the ADF CLI and is kept in the OS keychain, which Studio can't open on this machine, so Studio's agents can't use it. Manage this provider's key with /provider in the ADF CLI.
            </div>
          </Field>
        ) : (
          <Field
            label="API key"
            hint={provider.apiKeyStorage === 'secret-store'
              ? (provider.apiKeyStatus === 'missing' && !provider.apiKey
                ? <span className="text-[var(--adf-ui-warning)]">No key for this provider in the OS keychain. Enter one to store it there.</span>
                : 'Kept in the OS keychain, shared with the ADF CLI.')
              : entry?.keysUrl ? <ExternalLink href={entry.keysUrl}>Get a key ↗</ExternalLink> : entry?.keyOptional ? 'Most local servers accept any value or none.' : undefined}
          >
            <TextInput
              aria-label="API key"
              type="password"
              value={provider.apiKey}
              // The daemon answers a stored key as a placeholder (§4.2): typing replaces it, never edits it.
              onChange={(e) => onUpdate({ apiKey: editPlaceholderField(provider.apiKey ?? '', e.target.value) })}
              placeholder={entry?.keyPlaceholder ?? 'API key'}
              className="font-mono text-[12px]"
            />
          </Field>
        )}

        <Field label="Default model" hint={models?.error ? <span className="text-[var(--adf-ui-danger)]">{models.error}</span> : requireDefaultModel ?? 'Agents can pick another model; this is the starting point.'}>
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
        <Button variant="primary" onClick={onDone ?? onClose} disabled={doneBlocked}>Done</Button>
      </div>
    </div>
  )
}

function SubscriptionAuth({ auth, label }: { auth: SubscriptionAuthState; label: string }) {
  if (!auth.version) return <SubscriptionAccount auth={auth} label={label} />
  return (
    <>
      <LocalToolVersion auth={auth} />
      <SubscriptionAccount auth={auth} label={label} />
    </>
  )
}

/** Installed Claude Code version, and whether this runtime can use it. */
function LocalToolVersion({ auth }: { auth: SubscriptionAuthState }) {
  const outdated = !!auth.updateRequired
  return (
    <Field
      label="Claude Code"
      hint={outdated
        ? <span className="text-[var(--adf-ui-danger)]">ADF needs version {auth.minVersion} or newer. Run <code>claude update</code>, then check again.</span>
        : auth.minVersion ? `ADF needs version ${auth.minVersion} or newer.` : undefined}
    >
      <div className="flex items-center justify-between gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-2.5 py-1.5">
        <span className="font-mono text-[12px] text-[var(--adf-ui-text)]">{auth.version}</span>
        <span className="flex items-center gap-1.5">
          <span className={`text-[11px] ${outdated ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-success)]'}`}>
            {outdated ? 'Update required' : 'Supported'}
          </span>
          {outdated && auth.recheck && <Button variant="ghost" size="compact" onClick={auth.recheck}>Check again</Button>}
        </span>
      </div>
    </Field>
  )
}

function SubscriptionAccount({ auth, label }: { auth: SubscriptionAuthState; label: string }) {
  if (auth.updateRequired) {
    return (
      <Field label="Account">
        <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">Update Claude Code to sign in with {label}.</p>
      </Field>
    )
  }
  if (auth.authenticated) {
    const plan = auth.plan ? ` · ${auth.plan.charAt(0).toUpperCase()}${auth.plan.slice(1)} plan` : ''
    return (
      <Field label="Account" hint={auth.flowError ? <span className="text-[var(--adf-ui-danger)]">{auth.flowError}</span> : auth.signOutHint}>
        <div className="flex items-center justify-between rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-success)]/40 bg-[var(--adf-ui-success-subtle)] px-2.5 py-1.5">
          <span className="text-[12px] text-[var(--adf-ui-success)]">Signed in{auth.email ? ` as ${auth.email}` : ''}{plan}</span>
          <Button variant="ghost" size="compact" className="text-[var(--adf-ui-danger)]" onClick={auth.signOut}>Sign out</Button>
        </div>
      </Field>
    )
  }
  if (auth.installed === false) {
    return (
      <Field label="Account">
        <div className="space-y-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-3 py-2.5">
          <p className="text-[12px] leading-5 text-[var(--adf-ui-text)]">{label} uses your Claude Pro or Max plan through Claude Code, which isn't installed.</p>
          <div className="flex gap-1.5">
            {auth.installUrl && (
              <Button variant="primary" className="flex-1" onClick={() => window.open(auth.installUrl, '_blank', 'noopener,noreferrer')}>Install Claude Code</Button>
            )}
            {auth.recheck && <Button variant="secondary" onClick={auth.recheck}>Check again</Button>}
          </div>
        </div>
      </Field>
    )
  }
  if (auth.flowPending) {
    return <PendingBrowserSignIn auth={auth} />
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

function PendingBrowserSignIn({ auth }: { auth: SubscriptionAuthState }) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    if (!auth.submitCode || !code.trim()) return
    setSubmitting(true)
    try {
      await auth.submitCode(code)
      setCode('')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Field label="Account" hint={auth.flowError ? <span className="text-[var(--adf-ui-danger)]">{auth.flowError}</span> : undefined}>
      <div className="space-y-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] text-[var(--adf-ui-text)]">Finish signing in in your browser…</p>
          {auth.cancel && <Button variant="ghost" size="compact" onClick={auth.cancel}>Cancel</Button>}
        </div>
        {auth.flowUrl && (
          <p className="text-[11px]"><ExternalLink href={auth.flowUrl}>Open sign-in page ↗</ExternalLink></p>
        )}
        {auth.submitCode && (
          <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); void submit() }}>
            <p className="text-[10.5px] text-[var(--adf-ui-text-subtle)]">If the page shows a code, paste it here.</p>
            <div className="flex gap-1.5">
              <TextInput aria-label="Sign-in code" type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code" className="flex-1 font-mono text-[12px]" />
              <Button type="submit" variant="secondary" size="compact" disabled={!code.trim() || submitting} loading={submitting}>Submit</Button>
            </div>
          </form>
        )}
      </div>
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
