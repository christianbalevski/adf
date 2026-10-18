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
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import { DiscoveredRow, RemoteAccessSummary } from './RemoteAccessSettings'
import { checkRemoteDaemonUrl, remoteUrlOrigin, type RemoteUrlClass } from '../../../shared/utils/remote-backend-url'
import type { BackendDaemonStatus, BackendSettingsPatch, BackendSettingsView, RemoteCheckResult, StudioBackendMode } from '../../../shared/types/backend.types'

type MessageGroup = 'backend' | 'remote'

/**
 * The modes as users see them (owner decision 2026-10-17); internal ids stay
 * embedded/local/remote. Inside Studio is the legacy backend, kept for this
 * release only (owner decision 2026-10-16).
 */
const MODE_LABELS: Record<StudioBackendMode, string> = {
  embedded: 'Inside Studio (legacy)',
  local: 'This computer',
  remote: 'Remote computer',
}

/** Where agents run in each mode, for sentences ("Agents run on this computer."). */
const MODE_PLACES: Record<StudioBackendMode, string> = {
  embedded: 'inside Studio',
  local: 'on this computer',
  remote: 'on the remote computer',
}

/** One short sentence per mode; the guide has the rest (Learn more, Docs). */
const MODE_DESCRIPTIONS: Record<StudioBackendMode, string> = {
  embedded: 'Agents run inside Studio and stop when you quit.',
  local: 'Agents run in a background service on this computer and can keep running when Studio is closed.',
  remote: 'Agents run on another computer. Studio connects to it.',
}

/** A "Learn more" link to the guide after a row's one-sentence description. */
function LearnMore({ href }: { href: string }) {
  return <DocsLink href={href} label="Learn more" className="ml-1.5 !text-[11px]" />
}

/** Technical detail kept off a status line: a native disclosure, closed by default. */
function Details({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <details className="mt-1 text-[11px] text-[var(--adf-ui-text-subtle)]">
      <summary className="cursor-pointer select-none">Details</summary>
      <ul className="mt-1 space-y-0.5 break-all">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </details>
  )
}

/** The launch that moved this install off Embedded to the new default (W5-I), in one line; what moved is under Details. */
export function defaultSwitchLine(record: NonNullable<BackendSettingsView['defaultSwitch']>): string {
  const when = Number.isNaN(Date.parse(record.at)) ? record.at : new Date(record.at).toLocaleString()
  return `On ${when}, Studio${record.version ? ` ${record.version}` : ''} moved agents from inside Studio to this computer.`
}

/** "Default changed": what moved (under Details) and what was not done then (inline: a problem is never hidden). */
export function defaultSwitchDetails(record: NonNullable<BackendSettingsView['defaultSwitch']>): { moved: string; notDone: string | null } {
  return {
    moved: `Moved: ${record.moved.length > 0 ? record.moved.join(', ') : 'nothing'}.`,
    notDone: record.notDone.length > 0 ? `Not done then, retried at each start: ${record.notDone.join(' ')}` : null,
  }
}

function activeLine(view: BackendSettingsView): string {
  const place = MODE_PLACES[view.active.mode]
  const next = MODE_PLACES[view.configured.mode]
  if (view.active.source === 'env') return `Agents run ${place} because ADF_STUDIO_BACKEND is set.`
  if (view.active.source === 'session' && view.active.sessionReason) return `Agents run ${place} for this session only: ${view.active.sessionReason}`
  if (view.active.source === 'session') return `Agents run ${place} for this session only; from the next launch, ${next}.`
  if (view.active.mode !== view.configured.mode) return `Agents run ${place} until Studio restarts; then ${next}.`
  return `Agents run ${place}.`
}

const CONNECTION_LABELS: Record<BackendDaemonStatus['connection'], string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Not connected, retrying',
  failed: 'Not connected',
}

/**
 * MODE-02: the daemon this launch uses, terse: connection, pid, who started
 * it. A key the owner does not trust stays on the line (it needs an action);
 * the URL, version and a trusted key are under Details (daemonDetails), and
 * a keychain problem is the row's error.
 */
export function daemonLine(daemon: BackendDaemonStatus): string {
  const parts = [daemon.progress ?? CONNECTION_LABELS[daemon.connection]]
  if (daemon.pid) parts.push(`pid ${daemon.pid}`)
  if (daemon.startedBy) parts.push(daemon.how === 'spawned' ? 'started by this Studio' : `started by ${daemon.startedBy === 'studio' ? 'Studio' : daemon.startedBy === 'cli' ? 'the ADF CLI' : 'a service'}`)
  // K12 (no OS keychain): the owner's trust in the daemon's key, set with adf identity trust-daemon.
  if (daemon.trust?.state === 'not-trusted') parts.push('daemon key not trusted (adf identity trust-daemon)')
  return parts.join(' · ')
}

/** The daemon row's Details: URL, version, a trusted key. */
export function daemonDetails(daemon: BackendDaemonStatus): string[] {
  const lines: string[] = []
  if (daemon.url) lines.push(`URL: ${daemon.url}`)
  if (daemon.version) lines.push(`Version: ${daemon.version}`)
  if (daemon.trust?.state === 'trusted') lines.push('Daemon key: trusted by the owner')
  return lines
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

export function BackendSettings({ onOpenNetworking }: { onOpenNetworking?: () => void } = {}) {
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
  /** A pairing saved a URL and token in main: show them (drafts reset). */
  const reloadAfterPairing = () => {
    setCheck(null)
    window.adfApi.getBackendSettings().then((next) => adopt(next, true)).catch(() => {})
  }

  return (
    <>
      {view.active.notices.length > 0 && (
        <div role="status" className="mb-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
          {view.active.notices.map((notice) => <p key={notice}>{notice}</p>)}
        </div>
      )}
      {pendingRestart && (
        <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] px-3 py-2 text-[12px] text-[var(--adf-ui-text)]">
          <span>Agents run {MODE_PLACES[view.active.mode]}. Restart Studio to run them {MODE_PLACES[view.configured.mode]}.</span>
          <Button variant="primary" size="compact" onClick={restart}>Restart now</Button>
        </div>
      )}
      <SettingsGroup
        title="Mode"
        description="A change shows what moves, then restarts Studio."
        docs={DOCS.backendSwitch}
      >
        <SettingsRow
          label="Run agents in"
          description={<>
            {MODE_DESCRIPTIONS[view.configured.mode]}
            {view.configured.mode === 'embedded' && <LearnMore href={DOCS.backendEmbedded} />}
          </>}
          help={activeLine(view)}
        >
          <SegmentedControl
            value={view.configured.mode}
            options={(['embedded', 'local', 'remote'] as const).map((mode) => ({
              value: mode,
              label: MODE_LABELS[mode],
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
            description={<>
              {view.pendingSwitch.gaveUp
                ? `Still waiting after 30 minutes for ${view.pendingSwitch.waitingFor.join(', ') || 'a turn'}; Finish Switch Now stops the turns.`
                : `Studio restarts once the turns in flight finish (${view.pendingSwitch.waitingFor.join(', ') || 'none left'}).`}
              <LearnMore href={DOCS.backendTurns} />
            </>}
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
            description={<>{defaultSwitchLine(view.defaultSwitch)}<LearnMore href={DOCS.backendUpgrade} /></>}
            help={<>
              {defaultSwitchDetails(view.defaultSwitch).notDone}
              <Details lines={[defaultSwitchDetails(view.defaultSwitch).moved]} />
            </>}
          />
        )}
        {view.daemon && (
          <SettingsRow
            separator
            label="ADF daemon"
            description={<>{daemonLine(view.daemon)}<LearnMore href={DOCS.backendStatus} /></>}
            help={view.daemon.message || daemonDetails(view.daemon).length > 0 ? <>
              {view.daemon.message}
              <Details lines={daemonDetails(view.daemon)} />
            </> : undefined}
            error={[
              view.daemon.localProof && !view.daemon.localProof.available
                ? `The daemon runs without its local proof (${view.daemon.localProof.problem ?? 'unknown reason'}), so reveal and identity import are refused. Fix the file's permissions, then restart the daemon.`
                : null,
              view.daemon.keychainProblem,
            ].filter(Boolean).join(' ') || undefined}
          />
        )}
        {(view.configured.mode === 'local' || view.active.mode === 'local') && <SettingsRow
          separator
          label="Keep the daemon running when Studio quits"
          description={<>Your agents keep running after you quit. Stop them with adf daemon stop.<LearnMore href={DOCS.backendQuit} /></>}
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
        {(view.configured.mode === 'local' || view.active.mode === 'local') && onOpenNetworking && <RemoteAccessSummary onOpenNetworking={onOpenNetworking} />}
        {messageFor('backend') && (
          <div className="border-t border-[var(--adf-ui-separator)] px-4 py-2.5">
            <MessageLine message={messageFor('backend')} />
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Remote computer"
        description="Used when agents run on a remote computer."
        docs={DOCS.backendRemote}
      >
        <DiscoveredRow onPaired={reloadAfterPairing} onSwitch={() => void save('remote', { mode: 'remote' }, '')} />
        <SettingsRow
          stacked
          separator
          label="Daemon URL"
          help="https://, or http:// to localhost or a Tailscale address."
          error={urlCheck?.kind === 'invalid' ? urlCheck.reason : !urlChanged && view.remoteUrlProblem ? view.remoteUrlProblem : undefined}
        >
          <TextInput
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="https://adf.example.com"
            spellCheck={false}
            autoComplete="off"
            aria-label="Remote computer URL"
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
            ? 'Paste a token from Add a Computer on the other computer.'
            : view.configured.remotePaired && !originChanged && !tokenDraft.trim()
              ? `Paired with ${view.configured.remotePaired.name} as ${view.configured.remotePaired.label}. Enter a token to replace it.`
            : originChanged && !tokenDraft.trim()
              ? 'Saving the new address removes the saved token.'
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
              aria-label="Remote computer token"
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
            ? 'Studio uses this daemon now.'
            : remoteConfigured
              ? 'Saved as the backend; this launch does not run it.'
              : 'Shows what moves, then restarts Studio connected to this daemon.'}
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
