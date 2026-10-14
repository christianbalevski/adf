/**
 * Settings → Backend: where agents run (embedded in Studio, a local ADF
 * daemon, or a remote one). Stored in studio-backend.json by main and read at
 * launch.
 *
 * Choosing another mode opens main's switch dialog (what moves, what happens
 * to running agents); confirming restarts Studio into it, and the handover
 * runs at that start (design §11). Remote follows when remote mode ships
 * (`remoteSwitchAvailable`). The remote token is write-only here: main never
 * returns it, and this component never logs it.
 */

import { useEffect, useState } from 'react'
import { Button, SegmentedControl, SettingsGroup, SettingsRow, TextInput } from '../ui'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../../shared/utils/remote-backend-url'
import type { BackendDaemonStatus, BackendSettingsPatch, BackendSettingsView, StudioBackendMode } from '../../../shared/types/backend.types'

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

const CONNECTION_LABELS: Record<BackendDaemonStatus['connection'], string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Not connected, retrying',
  failed: 'Not connected',
}

/** MODE-02: the daemon this launch uses (local: pid, version, who started it). */
function daemonLine(daemon: BackendDaemonStatus): string {
  const parts = [daemon.progress ?? CONNECTION_LABELS[daemon.connection]]
  if (daemon.url) parts.push(daemon.url)
  if (daemon.pid) parts.push(`pid ${daemon.pid}`)
  if (daemon.version) parts.push(`version ${daemon.version}`)
  if (daemon.startedBy) parts.push(daemon.how === 'spawned' ? 'started by this Studio' : `started by ${daemon.startedBy === 'studio' ? 'Studio' : daemon.startedBy === 'cli' ? 'the ADF CLI' : 'a service'}`)
  return parts.join(' · ')
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

  // While Studio waits for its daemon, follow the progress ("Waiting for the ADF daemon (pid N)…").
  const daemonState = view?.daemon?.connection
  useEffect(() => {
    if (daemonState !== 'connecting' && daemonState !== 'disconnected') return
    const timer = setInterval(() => {
      window.adfApi?.getBackendSettings().then((next) => setView((prev) => prev ? { ...prev, daemon: next.daemon } : next)).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [daemonState])

  const save = async (group: MessageGroup, patch: BackendSettingsPatch, okText = 'Saved. Applies at the next launch.', resetDrafts = false) => {
    setSaving(true)
    setMessage(null)
    try {
      const result = await window.adfApi.setBackendSettings(patch)
      if (result.ok) {
        adopt(result.view, resetDrafts)
        setMessage({ group, kind: 'ok', text: [okText, ...result.notices].join(' ') })
      } else {
        setMessage({ group, kind: result.code === 'switch_cancelled' ? 'ok' : 'error', text: result.error })
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
    void save('remote', patch, undefined, true)
  }

  const messageFor = (group: MessageGroup) =>
    message?.group === group ? message : null

  return (
    <>
      <SettingsGroup
        title="Mode"
        description="Studio reads this at launch, so a change applies after a restart."
      >
        <SettingsRow
          label="Run agents in"
          description={MODE_DESCRIPTIONS[view.configured.mode]}
          help={view.modeSwitchAvailable
            ? `${activeLine(view)} Choosing another mode shows what moves, then restarts Studio.${view.remoteSwitchAvailable ? '' : ' Remote daemon is available in a later build.'}`
            : `${activeLine(view)} Switching the backend is available in a later build.`}
        >
          <SegmentedControl
            value={view.configured.mode}
            options={(['embedded', 'local', 'remote'] as const).map((mode) => ({
              value: mode,
              label: MODE_LABELS[mode],
              // Embedded stays selectable: it is how a hand-edited file is undone.
              disabled: saving || (mode !== view.configured.mode && mode !== 'embedded' &&
                (!view.modeSwitchAvailable || (mode === 'remote' && !view.remoteSwitchAvailable))),
            }))}
            onChange={(mode) => { if (mode !== view.configured.mode) void save('backend', { mode }, 'Saved. Studio is restarting.') }}
            ariaLabel="Backend"
          />
        </SettingsRow>
        {view.daemon && (
          <SettingsRow
            separator
            label="ADF daemon"
            description={daemonLine(view.daemon)}
            help={view.daemon.message ?? undefined}
            error={view.daemon.localProof && !view.daemon.localProof.available
              ? `The daemon runs without its local proof (${view.daemon.localProof.problem ?? 'unknown reason'}), so revealing stored values and importing an identity are refused. Restart the daemon after fixing the file's permissions.`
              : undefined}
          />
        )}
        <SettingsRow
          separator
          label="Keep the daemon running when Studio quits"
          description="Applies to Local daemon, at the next quit. Off: quitting Studio stops a daemon that Studio started, as quitting stops agents in embedded mode, unless another client (the terminal app) is connected; after a crash it stops 60 seconds later. A daemon started with adf daemon start is never stopped by Studio. On: the daemon keeps running your agents, and the ADF CLI manages it (adf daemon stop)."
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={view.configured.keepDaemonRunning}
              disabled={saving}
              onChange={(event) => void save('backend', { keepDaemonRunning: event.target.checked }, 'Saved. Applies at the next quit.')}
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
          error={urlCheck?.kind === 'invalid' ? urlCheck.reason : undefined}
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
          <Button variant="primary" disabled={!remoteDirty || remoteInvalid} loading={saving} onClick={saveRemote}>
            Save
          </Button>
        </div>
      </SettingsGroup>
    </>
  )
}
