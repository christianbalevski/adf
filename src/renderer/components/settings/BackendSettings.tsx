/**
 * Settings → Backend: where agents run (embedded in Studio, a local ADF
 * daemon, or a remote one). Stored in studio-backend.json by main and read at
 * launch, so every change applies at the next start.
 *
 * Switching the backend ships with the handover (later build); until then the
 * mode choice is shown but disabled. The remote token is write-only here:
 * main never returns it, and this component never logs it.
 */

import { useEffect, useState } from 'react'
import { Button, SegmentedControl, SettingsGroup, SettingsRow, TextInput } from '../ui'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../../shared/utils/remote-backend-url'
import type { BackendSettingsPatch, BackendSettingsView, RemoteCheckResult, StudioBackendMode } from '../../../shared/types/backend.types'

type MessageGroup = 'backend' | 'remote'

const MODE_LABELS: Record<StudioBackendMode, string> = {
  embedded: 'Embedded',
  local: 'Local daemon',
  remote: 'Remote daemon',
}

const MODE_DESCRIPTIONS: Record<StudioBackendMode, string> = {
  embedded: 'Agents run inside Studio and stop when Studio quits.',
  local: 'Agents run in an ADF daemon on this computer, with the same settings and files as Studio. Studio starts the daemon or attaches to a running one.',
  remote: 'Agents run in an ADF daemon on another computer, reached by URL and token.',
}

function activeLine(view: BackendSettingsView): string {
  const mode = MODE_LABELS[view.active.mode]
  if (view.active.source === 'env') return `This launch runs ${mode} because ADF_STUDIO_BACKEND is set.`
  if (view.active.mode !== view.configured.mode) return `This launch runs ${mode}. The next launch uses ${MODE_LABELS[view.configured.mode]}.`
  return `This launch runs ${mode}.`
}

function MessageLine({ message }: { message: { kind: 'ok' | 'error'; text: string } | null }) {
  if (!message) return <span />
  return (
    <span role="status" className={`text-[12px] ${message.kind === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`}>
      {message.text}
    </span>
  )
}

export function BackendSettings() {
  const [view, setView] = useState<BackendSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [urlDraft, setUrlDraft] = useState('')
  /**
   * Origin the plain-HTTP confirmation was given for. The checkbox shows as
   * checked only while the draft URL has this origin, so editing the URL to
   * another address clears it.
   */
  const [insecureFor, setInsecureFor] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [saving, setSaving] = useState(false)
  /** Result of the last save, shown in the group whose control triggered it. */
  const [message, setMessage] = useState<{ group: MessageGroup; kind: 'ok' | 'error'; text: string } | null>(null)
  /** Remote daemon: the last "Test connection" answer, and whether one runs. */
  const [check, setCheck] = useState<RemoteCheckResult | null>(null)
  const [checking, setChecking] = useState(false)

  /** Take main's view. Drafts reset only on load and after the remote Save, so other saves keep unsaved URL edits. */
  const adopt = (next: BackendSettingsView, resetDrafts: boolean) => {
    setView(next)
    if (!resetDrafts) return
    setUrlDraft(next.configured.remoteUrl ?? '')
    setInsecureFor(next.configured.allowInsecureHttp ? remoteUrlOrigin(next.configured.remoteUrl) : null)
    setTokenDraft('')
  }

  useEffect(() => {
    let cancelled = false
    window.adfApi?.getBackendSettings()
      .then((next) => { if (!cancelled) adopt(next, true) })
      .catch(() => { if (!cancelled) setLoadError('Could not read the backend settings.') })
    return () => { cancelled = true }
  }, [])

  const save = async (group: MessageGroup, patch: BackendSettingsPatch, okText = 'Saved. Applies at the next launch.', resetDrafts = false) => {
    setSaving(true)
    setMessage(null)
    try {
      const result = await window.adfApi.setBackendSettings(patch)
      if (result.ok) {
        adopt(result.view, resetDrafts)
        setMessage({ group, kind: 'ok', text: [okText, ...result.notices].join(' ') })
      } else {
        setMessage({ group, kind: 'error', text: result.error })
      }
    } catch {
      setMessage({ group, kind: 'error', text: 'Could not save the backend settings.' })
    } finally {
      setSaving(false)
    }
  }

  if (!view) {
    return (
      <SettingsGroup title="Backend">
        <SettingsRow label={loadError ?? 'Loading…'} />
      </SettingsGroup>
    )
  }

  const urlCheck = urlDraft.trim() ? checkRemoteDaemonUrl(urlDraft) : null
  const savedUrl = view.configured.remoteUrl ?? ''
  const urlChanged = (urlCheck?.url ?? urlDraft.trim()) !== savedUrl
  const originChanged = urlChanged && remoteUrlOrigin(urlCheck?.url) !== remoteUrlOrigin(savedUrl)
  const draftOrigin = remoteUrlOrigin(urlCheck?.url)
  const insecureConfirmed = draftOrigin !== null && insecureFor === draftOrigin
  const remoteDirty = urlChanged || insecureConfirmed !== view.configured.allowInsecureHttp || tokenDraft.trim() !== ''
  const remoteInvalid = urlCheck?.kind === 'invalid' || (urlCheck?.kind === 'insecure-http' && !insecureConfirmed)

  const saveRemote = () => {
    const patch: BackendSettingsPatch = { remoteUrl: urlDraft.trim() || null, allowInsecureHttp: insecureConfirmed }
    if (insecureConfirmed && draftOrigin) patch.insecureHttpOrigin = draftOrigin
    if (tokenDraft.trim()) patch.remoteToken = tokenDraft
    setCheck(null)
    void save('remote', patch, undefined, true)
  }

  // Remote daemon actions (W4-B): test the draft, switch to the saved daemon, restart.
  const testRemote = async () => {
    setChecking(true)
    setCheck(null)
    try {
      setCheck(await window.adfApi.checkRemoteBackend({ url: urlDraft.trim() || undefined, ...(tokenDraft.trim() ? { token: tokenDraft } : {}), allowInsecureHttp: insecureConfirmed }))
    } catch {
      setCheck({ ok: false, problem: 'unreachable', error: 'Studio could not run the check.' })
    } finally {
      setChecking(false)
    }
  }
  const remoteReady = !!view.configured.remoteUrl && view.configured.remoteTokenSaved && !view.remoteUrlProblem && !remoteDirty
  const remoteConfigured = view.configured.mode === 'remote'
  const remoteActive = view.active.mode === 'remote'
  const restart = () => { void window.adfApi.restartStudio() }

  const messageFor = (group: MessageGroup) =>
    message?.group === group ? message : null

  return (
    <>
      {view.active.notices.length > 0 && (
        <div role="status" className="mb-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
          {view.active.notices.map((notice) => <p key={notice}>{notice}</p>)}
        </div>
      )}
      <SettingsGroup
        title="Mode"
        description="Studio reads this at launch, so a change applies after a restart."
      >
        <SettingsRow
          label="Run agents in"
          description={MODE_DESCRIPTIONS[view.configured.mode]}
          help={view.modeSwitchAvailable ? activeLine(view) : `${activeLine(view)} Switching the backend is available in a later build.`}
        >
          <SegmentedControl
            value={view.configured.mode}
            options={(['embedded', 'local', 'remote'] as const).map((mode) => ({
              value: mode,
              label: MODE_LABELS[mode],
              // Embedded stays selectable: it is how a hand-edited file is undone.
              disabled: !view.modeSwitchAvailable && mode !== view.configured.mode && mode !== 'embedded',
            }))}
            onChange={(mode) => { if (mode !== view.configured.mode) void save('backend', { mode }) }}
            ariaLabel="Backend"
          />
        </SettingsRow>
        <SettingsRow
          separator
          label="Keep the daemon running when Studio quits"
          description="Applies to Local daemon. Off: quitting Studio stops a daemon that Studio started, as quitting stops agents in embedded mode. On: the daemon keeps running your agents, and the ADF CLI manages it (adf daemon stop)."
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={view.configured.keepDaemonRunning}
              disabled={saving}
              onChange={(event) => void save('backend', { keepDaemonRunning: event.target.checked }, 'Saved. Applies at the next launch.')}
              className="rounded text-blue-500"
            />
            <span className="text-[12px] text-[var(--adf-ui-text-muted)]">
              {view.configured.keepDaemonRunning ? 'On' : 'Off'}
            </span>
          </label>
        </SettingsRow>
        {messageFor('backend') && (
          <div className="border-t border-[var(--adf-ui-separator)] px-4 py-2.5">
            <MessageLine message={messageFor('backend')} />
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Remote daemon"
        description="Used when the backend is Remote daemon. The token is stored encrypted with the OS keychain and is never shown again after you save it."
      >
        <SettingsRow
          stacked
          label="Daemon URL"
          help="https://, or http:// to localhost (an SSH tunnel) or a Tailscale address (100.64.0.0/10)."
          error={urlCheck?.kind === 'invalid' ? urlCheck.reason : !urlChanged && view.remoteUrlProblem ? view.remoteUrlProblem : undefined}
        >
          <TextInput
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="https://adf.example.com"
            spellCheck={false}
            autoComplete="off"
            aria-label="Remote daemon URL"
          />
          {urlCheck?.kind === 'insecure-http' && (
            <label className="mt-2 flex items-center gap-2 cursor-pointer text-[12px] text-[var(--adf-ui-text-muted)]">
              <input
                type="checkbox"
                checked={insecureConfirmed}
                onChange={(event) => setInsecureFor(event.target.checked ? draftOrigin : null)}
                className="rounded text-blue-500"
              />
              I trust this network; the token is sent unencrypted.
            </label>
          )}
        </SettingsRow>
        <SettingsRow
          stacked
          separator
          label="Token"
          description={!view.configured.remoteTokenSaved
            ? 'Run adf daemon token on the server and paste the result.'
            : originChanged && !tokenDraft.trim()
              ? 'A token is saved for the old address. Saving the new address removes it.'
              : 'A token is saved. Enter a new one to replace it.'}
          error={view.encryptionAvailable ? undefined : (view.encryptionUnavailableReason ?? 'OS keychain encryption is not available, so a token cannot be saved.')}
        >
          <div className="flex items-center gap-2">
            <TextInput
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder={view.configured.remoteTokenSaved ? '••••••••••••' : 'Daemon token'}
              disabled={!view.encryptionAvailable}
              spellCheck={false}
              autoComplete="off"
              aria-label="Remote daemon token"
            />
            {view.configured.remoteTokenSaved && (
              <Button variant="danger" disabled={saving} onClick={() => void save('remote', { clearRemoteToken: true }, 'Token removed.')}>
                Remove token
              </Button>
            )}
          </div>
        </SettingsRow>
        <div className="flex items-center justify-between gap-4 border-t border-[var(--adf-ui-separator)] px-4 py-3">
          <MessageLine message={messageFor('remote')} />
          <div className="flex items-center gap-2">
            <Button disabled={remoteInvalid || !urlDraft.trim()} loading={checking} onClick={() => void testRemote()}>
              Test connection
            </Button>
            <Button variant="primary" disabled={!remoteDirty || remoteInvalid} loading={saving} onClick={saveRemote}>
              Save
            </Button>
          </div>
        </div>
        {check && (
          <div className="border-t border-[var(--adf-ui-separator)] px-4 py-2.5">
            <MessageLine message={check.ok
              ? { kind: 'ok', text: `Connected to the ADF daemon at ${check.url} (version ${check.version}, started by ${check.startedBy}).` }
              : { kind: 'error', text: check.error }}
            />
          </div>
        )}
        <SettingsRow
          separator
          label="Use this daemon"
          description={remoteActive
            ? 'Studio is using this remote daemon. Choose Embedded above to run agents in Studio again.'
            : remoteConfigured
              ? 'Saved: Studio connects to this daemon at the next launch.'
              : 'Studio restarts and connects to the saved daemon. Agents that run in Studio now stop when it quits; agents in the remote daemon keep running there.'}
        >
          {remoteConfigured && !remoteActive ? (
            <Button variant="primary" onClick={restart}>Restart now</Button>
          ) : !remoteConfigured ? (
            <Button
              disabled={!view.remoteSwitchAvailable || !remoteReady || saving}
              onClick={() => void save('remote', { mode: 'remote' }, 'Saved. Studio connects to the remote daemon after a restart.')}
            >
              Switch to remote daemon
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
