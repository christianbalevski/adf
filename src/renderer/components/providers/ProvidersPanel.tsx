import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { catalogEntryForProvider, providerTypeHint } from '../../../shared/constants/provider-catalog'
import { BrandMark } from '../common/BrandMark'
import { Tooltip } from '../common/Tooltip'
import { Button } from '../ui'
import { ProviderModal } from './ProviderModal'
import { providerDotClass, providerStatusLabel } from './provider-status'
import { useProviderManager } from './useProviderManager'

interface ProvidersPanelProps {
  /** False until the settings store has been read; the list shows a placeholder meanwhile. */
  loaded: boolean
  providers: ProviderConfig[]
  setProviders: React.Dispatch<React.SetStateAction<ProviderConfig[]>>
  defaultProviderId: string | undefined
  setDefaultProviderId: (id: string | undefined) => void
  /**
   * Persist pending settings now (the page debounces saves) so Test / Fetch
   * models see fresh values. Resolves once the write has landed.
   */
  flushSave: () => Promise<void> | void
  onOpenTemplate: () => void
}

/**
 * Settings → Providers: one row per configured provider, a picker modal to
 * add more, and a modal per row for the app default + agent overrides. Edits
 * apply live (the page's debounced save persists them), matching the MCP tab.
 * The state behind the modal lives in useProviderManager, shared with the
 * provider-at-need sheet.
 */
export function ProvidersPanel({ loaded, providers, setProviders, defaultProviderId, setDefaultProviderId, flushSave, onOpenTemplate }: ProvidersPanelProps) {
  const m = useProviderManager({ providers, setProviders, defaultProviderId, setDefaultProviderId, flushSave })

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <label className="block text-[13px] font-medium text-[var(--adf-ui-text)]">Providers</label>
          <p className="mt-0.5 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
            New agents start on the default provider; change that under{' '}
            <button type="button" onClick={onOpenTemplate} className="rounded underline underline-offset-2 hover:text-[var(--adf-ui-text)] focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]">Agent template</button>.
          </p>
        </div>
        <Button variant="primary" size="compact" className="shrink-0" onClick={m.openPicker}>+ Add provider</Button>
      </div>

      <ProviderModal {...m.modalProps} />

      {!loaded ? (
        <div className="space-y-2" aria-busy="true">
          <div className="h-[3.6rem] animate-pulse rounded-[var(--adf-ui-container-radius)] bg-[var(--adf-ui-surface)]" />
          <div className="h-[3.6rem] animate-pulse rounded-[var(--adf-ui-container-radius)] bg-[var(--adf-ui-surface)]" />
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-[var(--adf-ui-container-radius)] bg-[var(--adf-ui-surface)] px-4 py-6 text-center shadow-subtle">
          <p className="text-[13px] font-medium text-[var(--adf-ui-text)]">No providers yet</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
            Sign in with a ChatGPT or Grok subscription, paste an API key, or point at a local server like LM Studio or Ollama.
          </p>
          <Button variant="primary" className="mt-3" onClick={m.openPicker}>Choose a provider</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => {
            const entry = catalogEntryForProvider(p)
            const st = m.status[p.id]
            const isDefault = p.id === defaultProviderId
            const carriers = m.carrierCounts[p.id] ?? 0
            const detail = p.type === 'openai-compatible' && p.baseUrl ? p.baseUrl : providerTypeHint(p.type)
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => m.openRow(p.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); m.openRow(p.id) } }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-[var(--adf-ui-container-radius)] bg-[var(--adf-ui-surface)] px-4 py-3 shadow-subtle transition-colors hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <BrandMark iconKey={entry?.iconKey} label={entry?.label ?? p.name} size={26} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Tooltip tip={providerStatusLabel(st)}>
                        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${providerDotClass(st)}`} />
                      </Tooltip>
                      <span className="truncate text-[13px] font-medium text-[var(--adf-ui-text)]">{p.name || entry?.label}</span>
                      {isDefault && (
                        <Tooltip tip="New agents start on this provider.">
                          <span className="rounded bg-[var(--adf-ui-warning-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--adf-ui-warning)]">Default</span>
                        </Tooltip>
                      )}
                      {carriers > 0 && (
                        <Tooltip tip={`${carriers} agent${carriers === 1 ? '' : 's'} use their own key, model, params, or delay for this provider.`}>
                          <span className="rounded bg-[var(--adf-ui-accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--adf-ui-accent)]">
                            {carriers} override{carriers === 1 ? '' : 's'}
                          </span>
                        </Tooltip>
                      )}
                    </div>
                    <p className="truncate text-[10.5px] text-[var(--adf-ui-text-subtle)]">
                      {detail}{p.defaultModel ? ` · ${p.defaultModel}` : ''}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]">Configure ›</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
