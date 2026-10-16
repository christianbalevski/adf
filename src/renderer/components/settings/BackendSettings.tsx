/**
 * Settings → Backend: where agents run (embedded in Studio, a local ADF
 * daemon, or a remote one). Stored in studio-backend.json by main and read at
 * launch.
 *
 * Choosing another mode opens main's switch dialog (what moves, what happens
 * to running agents); confirming restarts Studio into it, and the handover
 * runs at that start (design §11); a switch to or from Remote daemon moves
 * client settings only. The remote token is write-only here: main never
 * returns it, and this component never logs it.
 */

import { useEffect, useState } from 'react'
import { Button, SegmentedControl, SettingsGroup, SettingsRow, TextInput } from '../ui'
import { checkRemoteDaemonUrl, remoteUrlOrigin, type RemoteUrlClass } from '../../../shared/utils/remote-backend-url'
import type { BackendDaemonStatus, BackendSettingsPatch, BackendSettingsView, RemoteCheckResult, StudioBackendMode } from '../../../shared/types/backend.types'

type MessageGroup = 'backend' | 'remote'

const MODE_LABELS: Record<StudioBackendMode, string> = {
  embedded: 'Embedded',
  local: 'Local daemon',
  remote: 'Remote daemon',
}

/** The control's options: Embedded is the legacy backend, kept for this release only (owner decision 2026-10-16). */
const OPTION_LABELS: Record<StudioBackendMode, string> = {
  ...MODE_LABELS,
  embedded: 'Embedded (legacy, removed in the next release)',
}

const EMBEDDED_LEGACY = 'Embedded runs agents inside Studio as before; it stays for this release as a fallback if the daemon does not work for you, and the next release removes it.'

const MODE_DESCRIPTIONS: Record<StudioBackendMode, string> = {
  embedded: 'Agents run inside Studio and stop when Studio quits.',
  local: 'Agents run in an ADF daemon on this computer, with the same settings and files as Studio. Studio starts the daemon or attaches to a running one.',
  remote: 'Agents run in an ADF daemon on another computer, reached by URL and token.',
}

/** The launch that moved this install off Embedded to the new default (W5-I), in one line. */
export function defaultSwitchLine(record: NonNullable<BackendSettingsView['defaultSwitch']>): string {
  const when = Number.isNaN(Date.parse(record.at)) ? record.at : new Date(record.at).toLocaleString()
  const moved = record.moved.length > 0 ? record.moved.join(', ') : 'nothing'
  const notDone = record.notDone.length > 0 ? ` Not done then, retried at each start: ${record.notDone.join(' ')}` : ''
  return `On ${when}, Studio${record.version ? ` ${record.version}` : ''} switched this install from Embedded to Local daemon, the new default. Moved: ${moved}.${notDone}`
}

function activeLine(view: BackendSettingsView): string {
  const mode = MODE_LABELS[view.active.mode]
  if (view.active.source === 'env') return `This launch runs ${mode} because ADF_STUDIO_BACKEND is set.`
  if (view.active.source === 'session') return `This launch runs ${mode} for this session only (the ADF daemon's version did not match, or it could not be reached). The next launch uses ${MODE_LABELS[view.configured.mode]}.`
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
  // K12 (no OS keychain): the owner's trust in the daemon's key, set with adf identity trust-daemon.
  if (daemon.trust?.state === 'trusted') parts.push('daemon key trusted by the owner')
  else if (daemon.trust?.state === 'not-trusted') parts.push('daemon key not trusted (adf identity trust-daemon)')
  if (daemon.keychainProblem) parts.push('keychain unavailable')
  return parts.join(' · ')
}

/**
 * Why Save is refused for the remote draft, or null. An invalid URL is
 * refused; so is plain http that is not confirmed, except the saved URL with
 * its confirmation unchecked and no new token: saving that withdraws the
 * confirmation (main keeps the token; the transport rule then blocks
 * connecting until the box is checked again or the URL changes).
 */
export function remoteSaveBlocked(draft: { kind: RemoteUrlClass | null; urlChanged: boolean; confirmed: boolean; savedConfirmed: boolean; newToken: boolean }): 'invalid' | 'unconfirmed' | null {
  if (draft.kind === 'invalid') return 'invalid'
  if (draft.kind !== 'insecure-http' || draft.confirmed) return null
  const withdrawing = !draft.urlChanged && draft.savedConfirmed && !draft.newToken
  return withdrawing ? null : 'unconfirmed'
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

  // While Studio waits for its daemon ("Waiting for the ADF daemon (pid N)…") or a switch waits for turns in flight, follow it.
  const daemonState = view?.daemon?.connection
  const switchWaiting = !!view?.pendingSwitch
  useEffect(() => {
    if (daemonState !== 'connecting' && daemonState !== 'disconnected' && !switchWaiting) return
    const timer = setInterval(() => {
      window.adfApi?.getBackendSettings().then((next) => setView((prev) => prev ? { ...prev, daemon: next.daemon, pendingSwitch: next.pendingSwitch } : next)).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [daemonState, switchWaiting])

  const save = async (group: MessageGroup, patch: BackendSettingsPatch, okText = 'Saved. Applies at the next launch.', resetDrafts = false) => {
    setSaving(true)
    setMessage(null)
    try {
      const result = await window.adfApi.setBackendSettings(patch)
      if (result.ok) {
        adopt(result.view, resetDrafts)
        setMessage({ group, kind: 'ok', text: [okText, ...result.notices].filter(Boolean).join(' ') })
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
  const saveBlocked = remoteSaveBlocked({ kind: urlCheck?.kind ?? null, urlChanged, confirmed: insecureConfirmed, savedConfirmed: view.configured.allowInsecureHttp, newToken: tokenDraft.trim() !== '' }) !== null

  const saveRemote = () => {
    const patch: BackendSettingsPatch = { remoteUrl: urlDraft.trim() || null, allowInsecureHttp: insecureConfirmed }
    if (insecureConfirmed && draftOrigin) patch.insecureHttpOrigin = draftOrigin
    if (tokenDraft.trim()) patch.remoteToken = tokenDraft
    setCheck(null)
    void save('remote', patch, undefined, true)
  }

  // Remote daemon actions (W4-B): test the draft, switch to the saved daemon (main's switch dialog, then the restart).
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
  /**
   * A saved mode this launch does not run outside a switch (a launch that fell
   * back, a hand-edited file). Not for ADF_STUDIO_BACKEND or a session-only
   * launch, which say so above, nor a switch waiting for turns in flight.
   */
  const pendingRestart = view.active.source !== 'env' && view.active.source !== 'session' && !view.pendingSwitch && view.configured.mode !== view.active.mode

  const messageFor = (group: MessageGroup) =>
    message?.group === group ? message : null

  return (
    <>
      {view.active.notices.length > 0 && (
        <div role="status" className="mb-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
          {view.active.notices.map((notice) => <p key={notice}>{notice}</p>)}
        </div>
      )}
      {pendingRestart && (
        <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
          <span>This launch runs {MODE_LABELS[view.active.mode]}. Restart Studio to use {MODE_LABELS[view.configured.mode]}.</span>
          <Button variant="primary" size="compact" onClick={restart}>Restart now</Button>
        </div>
      )}
      <SettingsGroup
        title="Mode"
        description="Studio reads this at launch, so a change applies after a restart."
      >
        <SettingsRow
          label="Run agents in"
          description={`${MODE_DESCRIPTIONS[view.configured.mode]} ${EMBEDDED_LEGACY}`}
          help={`${activeLine(view)} Choosing another mode shows what moves, then restarts Studio.`}
        >
          <SegmentedControl
            value={view.configured.mode}
            options={(['embedded', 'local', 'remote'] as const).map((mode) => ({
              value: mode,
              label: OPTION_LABELS[mode],
              disabled: saving,
            }))}
            onChange={(mode) => { if (mode !== view.configured.mode) void save('backend', { mode }, 'Saved.') }}
            ariaLabel="Backend"
          />
        </SettingsRow>
        {view.pendingSwitch && (
          <SettingsRow
            separator
            label={`Switching to ${MODE_LABELS[view.pendingSwitch.target]}`}
            description={view.pendingSwitch.gaveUp
              ? `Still waiting for ${view.pendingSwitch.waitingFor.join(', ') || 'a turn'} after 30 minutes. Finish the switch now (the turns are stopped), or cancel it and stay in ${MODE_LABELS[view.active.mode]}.`
              : `Studio restarts once the turns in flight finish (${view.pendingSwitch.waitingFor.join(', ') || 'none left'}).`}
          >
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={saving} onClick={() => void save('backend', { switchAction: 'finish-now' }, '')}>Finish Switch Now</Button>
              <Button disabled={saving} onClick={() => void save('backend', { switchAction: 'cancel' }, '')}>Cancel Switch</Button>
            </div>
          </SettingsRow>
        )}
        {view.defaultSwitch && (
          <SettingsRow
            separator
            label="Default changed"
            description={defaultSwitchLine(view.defaultSwitch)}
          />
        )}
        {view.daemon && (
          <SettingsRow
            separator
            label="ADF daemon"
            description={daemonLine(view.daemon)}
            help={view.daemon.message ?? undefined}
            error={[
              view.daemon.localProof && !view.daemon.localProof.available
                ? `The daemon runs without its local proof (${view.daemon.localProof.problem ?? 'unknown reason'}), so revealing stored values and importing an identity are refused. Restart the daemon after fixing the file's permissions.`
                : null,
              view.daemon.keychainProblem,
            ].filter(Boolean).join(' ') || undefined}
          />
        )}
        {(view.configured.mode === 'local' || view.active.mode === 'local') && <SettingsRow
          separator
          label="Keep the daemon running when Studio quits"
          description="Off: quitting Studio stops a daemon that Studio started, as quitting stops agents in embedded mode; with another client (the terminal app) connected it stops when that one disconnects; after a crash it stops 60 seconds later. A daemon started with adf daemon start is never stopped by Studio. On: the daemon keeps running your agents, and the ADF CLI manages it (adf daemon stop)."
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={view.configured.keepDaemonRunning}
              disabled={saving}
              onChange={(event) => void save('backend', { keepDaemonRunning: event.target.checked }, 'Saved. Applies from now on.')}
              className="rounded text-blue-500"
            />
            <span className="text-[12px] text-[var(--adf-ui-text-muted)]">
              {view.configured.keepDaemonRunning ? 'On' : 'Off'}
            </span>
          </label>
        </SettingsRow>}
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
            <Button variant="primary" disabled={!remoteDirty || saveBlocked} loading={saving} onClick={saveRemote}>
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
            ? 'Studio is using this remote daemon. Choose another mode above to switch back.'
            : remoteConfigured
              ? 'Saved as the backend; this launch does not run it.'
              : 'Shows what moves (client settings only; sign-ins and keys stay on this computer) and what happens to running agents, then restarts Studio connected to this daemon.'}
        >
          {!remoteConfigured && (
            <Button
              disabled={!remoteReady || saving}
              onClick={() => void save('remote', { mode: 'remote' }, '')}
            >
              Switch to This Daemon
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
