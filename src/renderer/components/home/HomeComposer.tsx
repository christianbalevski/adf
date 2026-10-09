import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdfFile } from '../../hooks/useAdfFile'
import { useAppStore } from '../../stores/app.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { pickSuggestions } from './suggestions'
import { SuggestionMarquee } from './SuggestionMarquee'
import { FolderPickerChip, ProviderPickerChip, TemplatePickerChip } from './HomePickers'
import { useHomeProviders } from './HomeProviders'
import { useTemplatesStore } from '../../hooks/useTemplates'
import { NameChip } from './NameChip'
import type { IdentityDraftHandle } from './NextAgentIdentity'
import { generateAgentName } from '../../../shared/utils/agent-names'

const MAX_ROWS = 8
/** Suggestion rows above the bar, each a slow marquee; drawn from the pool per visit. */
const MARQUEE_ROWS = 3
const CHIPS_PER_ROW = 7
/** Per-viewer switch for the rows; 'off' hides them. Survives restarts. */
const SUGGESTIONS_KEY = 'adf-home-suggestions'

function loadSuggestionsOn(): boolean {
  try { return localStorage.getItem(SUGGESTIONS_KEY) !== 'off' } catch { return true }
}
function saveSuggestionsOn(on: boolean): void {
  try { localStorage.setItem(SUGGESTIONS_KEY, on ? 'on' : 'off') } catch { /* private window */ }
}

/**
 * The home composer. A message sent here makes a new agent (generated name,
 * agents folder), opens it with the loop in the center, and lands the text
 * as the agent's first user message. Every send is a new agent; existing
 * ones are reached from the sidebar.
 *
 * The box always takes input. With no provider connected the send still
 * creates the agent; the provider sheet opens on the first start, from the
 * same path every start uses.
 */
export function HomeComposer({ identity, onReroll, onCreated, onSending }: {
  /** The next agent's identity draft, owned by HomeScreen (its orbital shows there). */
  identity: IdentityDraftHandle
  /** A name reroll: HomeScreen renews the identity with it and counts it. */
  onReroll: () => void
  /** After a successful create, before the next agent's name and identity land. */
  onCreated?: () => void
  /** A create started (true) or ended (false), for the orbital to react. */
  onSending?: (on: boolean) => void
}) {
  const { createQuickAgent } = useAdfFile()
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const setChatPlacement = useAppStore((s) => s.setChatPlacement)
  const setCenterChatTabActive = useAppStore((s) => s.setCenterChatTabActive)
  // The provider the chip shows: an explicit pick, else the app default.
  // The create call gets exactly that, so what the user sees is what the
  // agent starts on (the settings template's provider never wins silently).
  const { selectedId: providerId } = useHomeProviders()
  // The template the agent is built from, and the model the chip settled on.
  // Both go to main as chosen here; main resolves a null template to the
  // default one itself.
  const homeTemplateId = useAppStore((s) => s.homeTemplateId)
  const setHomeTemplateId = useAppStore((s) => s.setHomeTemplateId)
  const homeModelId = useAppStore((s) => s.homeModelId)
  const openTemplateReview = useAppStore((s) => s.openTemplateReview)
  const defaultTemplateId = useTemplatesStore((s) => s.defaultId)
  const homeFolder = useAppStore((s) => s.homeFolder)
  const homeName = useAppStore((s) => s.homeName)
  const setHomeName = useAppStore((s) => s.setHomeName)
  // A name is drawn the first time the composer shows and kept until a send.
  useEffect(() => { if (!homeName) setHomeName(generateAgentName()) }, [homeName, setHomeName])
  const name = homeName ?? ''
  // The create adopts exactly the identity whose orbital is on screen.
  const { renew: renewIdentity, current: currentIdentity } = identity
  const [busy, setBusy] = useState(false)
  // While a create is out it holds the current draft; a reroll then would
  // discard the draft it is adopting. Send renews it afterwards anyway.
  const busyRef = useRef(false)
  busyRef.current = busy
  const sendingRef = useRef(onSending)
  sendingRef.current = onSending
  useEffect(() => { sendingRef.current?.(busy) }, [busy])
  const reroll = useCallback(() => { if (!busyRef.current) onReroll() }, [onReroll])
  const [error, setError] = useState<string | null>(null)
  // A refused name (bad characters, or already a file in the folder) turns
  // the chip red, shakes it, and puts the reason in red under the box. The
  // count bumps per refusal so a repeat refusal shakes again.
  const [refused, setRefused] = useState(0)
  const refuseName = useCallback((reason: string) => {
    setError(reason)
    setRefused((n) => n + 1)
  }, [])
  // The folder the file will land in, for the taken-name check on commit.
  // Only tracked folders can be checked here; main checks again on send.
  const filesByDir = useTrackedDirsStore((s) => s.filesByDir)
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.adfApi.getDefaultAgentsFolder().then((r) => { if (!cancelled) setDefaultFolder(r.path) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const targetFolder = homeFolder ?? defaultFolder
  const nameTaken = useCallback((candidate: string): boolean => {
    if (!targetFolder) return false
    const want = `${candidate}.adf`.toLowerCase()
    return (filesByDir[targetFolder] ?? []).some((e) => !e.isDirectory && e.fileName.toLowerCase() === want)
  }, [filesByDir, targetFolder])
  const onNameChange = useCallback((next: string) => {
    setHomeName(next)
    setError(null)
    if (nameTaken(next)) refuseName(`An agent named "${next}" already exists in ${targetFolder?.split('/').pop() ?? 'that folder'}.`)
  }, [nameTaken, refuseName, setHomeName, targetFolder])
  // The draft lives in the store so leaving home and coming back keeps it.
  const text = useAppStore((s) => s.homeDraft)
  const setText = useAppStore((s) => s.setHomeDraft)
  // Files to hand the agent with its first message. Held here (the agent
  // does not exist yet) and uploaded into it right after it is created.
  const files = useAppStore((s) => s.homeFiles)
  const setFiles = useAppStore((s) => s.setHomeFiles)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const addFiles = (list: FileList | File[]) => {
    const next = Array.from(list)
    if (next.length > 0) setFiles([...files, ...next])
  }
  const removeFile = (i: number) => setFiles(files.filter((_, j) => j !== i))
  const [suggestionsOn, setSuggestionsOn] = useState(loadSuggestionsOn)
  const toggleSuggestions = () => {
    const next = !suggestionsOn
    setSuggestionsOn(next)
    saveSuggestionsOn(next)
  }
  const [rows] = useState(() => {
    const picks = pickSuggestions(MARQUEE_ROWS * CHIPS_PER_ROW)
    return Array.from({ length: MARQUEE_ROWS }, (_, i) => picks.slice(i * CHIPS_PER_ROW, (i + 1) * CHIPS_PER_ROW))
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Grow with the text up to MAX_ROWS, then scroll.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22
    const max = line * MAX_ROWS
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // The same send, run again once the owner accepts a template's review. Held
  // in a ref so the review callback does not pin an old copy of the state.
  const sendRef = useRef<() => Promise<void>>(async () => {})

  const send = useCallback(async () => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await createQuickAgent(message, {
        providerId: providerId ?? undefined,
        templateId: homeTemplateId ?? undefined,
        modelId: homeModelId ?? undefined,
        folder: homeFolder ?? undefined,
        name: homeName ?? undefined,
        identityDraftId: currentIdentity()?.draftId,
        files: files.length > 0 ? files : undefined
      })
      if (!result.success) {
        if (result.code === 'name_taken') refuseName(result.error ?? 'That name is taken.')
        else if (result.code === 'template_unreviewed') {
          // The template came from someone else. Review it once, then make
          // the agent; nothing was created on this attempt.
          const templateId = homeTemplateId ?? defaultTemplateId
          const fallback = result.error ?? 'That template has not been reviewed yet.'
          try {
            const check = await window.adfApi.checkTemplateReview(templateId)
            if (check.needsReview && check.configSummary) {
              openTemplateReview(templateId, check.configSummary, (accepted) => {
                if (accepted) void sendRef.current()
                else setError('That template has not been reviewed, so no agent was created.')
              })
            } else setError(fallback)
          } catch {
            setError(fallback)
          }
        } else if (result.code === 'template_missing') {
          setError(result.error ?? 'That template is not in the templates folder any more.')
          setHomeTemplateId(null)
        } else {
          setError(result.error ?? 'Could not create the agent')
          // The create may have used the draft before failing; mint another so
          // the DID on screen is the one the next agent gets.
          renewIdentity()
        }
        return
      }
      setText('')
      setFiles([])
      // The next agent gets its own name and identity (the create used this one).
      setHomeName(generateAgentName())
      renewIdentity()
      onCreated?.()
      setShowMeshGraph(false)
      // The loop takes the stage: the agent's first turn is the whole point
      // of the screen the user is about to see.
      setChatPlacement('center')
      setCenterChatTabActive(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      renewIdentity()
    } finally {
      setBusy(false)
    }
  }, [busy, createQuickAgent, defaultTemplateId, files, homeFolder, homeModelId, homeName, homeTemplateId, currentIdentity, onCreated, openTemplateReview, providerId, refuseName, renewIdentity, setCenterChatTabActive, setChatPlacement, setFiles, setHomeName, setHomeTemplateId, setShowMeshGraph, setText, text])
  sendRef.current = send

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const fill = (suggestion: string) => {
    setText(suggestion)
    setError(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  const canSend = text.trim().length > 0 && !busy

  return (
    <div className="space-y-4">
      {/* Three rows of suggestions drifting past each other, alternating
          direction. Full width; hover pauses so a chip can be clicked. */}
      {suggestionsOn && <SuggestionMarquee rows={rows} onPick={fill} disabled={busy} />}

      <div className="mx-auto w-full max-w-3xl px-4">
      <div
        className={`home-composer relative rounded-[var(--radius-sm)] border bg-[var(--paper)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)] ${dragOver ? 'border-[var(--blue)] outline outline-2 outline-offset-2 outline-[var(--focus)]' : 'border-[var(--rule-strong)]'}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false) }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) addFiles(e.dataTransfer.files) }}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[var(--adf-ui-accent-subtle)] text-sm font-medium text-[var(--adf-ui-text)]">
            Drop to attach
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--rule)] bg-[var(--paper-sunken)] px-2 py-1 text-[11px] text-[var(--adf-ui-text-muted)]">
                <span className="max-w-[12rem] truncate">{f.name}</span>
                <button type="button" onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`} className="shrink-0 text-[var(--adf-ui-text-subtle)] hover:text-[var(--adf-ui-danger)]">&times;</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          rows={1}
          placeholder={name ? `Tell ${name} what to do` : 'Tell your new agent what to do'}
          aria-label="Message for a new agent"
          data-orbital-look="composer"
          className="home-composer-input block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-[22px] text-[var(--adf-ui-text)] placeholder:text-[var(--adf-ui-text-subtle)] focus:outline-none disabled:opacity-60"
        />
        {/* Its own row, not an overlay: long text scrolls inside the textarea
            above and can never run underneath the chips. */}
        <div className="flex items-center justify-between gap-3 px-2.5 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { addFiles(e.target.files ?? []); e.currentTarget.value = '' }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-label="Attach files"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--adf-ui-text-muted)] transition-colors hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] disabled:opacity-40"
            >
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden>
                <path d="M9 3.25v11.5M3.25 9h11.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
            {/* Bad characters: the chip shakes on its own and keeps the old
                name; only the reason goes red below. Taken names go red too. */}
            {name && <NameChip name={name} onChange={onNameChange} onSpin={reroll} onInvalid={setError} refused={refused} />}
            <TemplatePickerChip />
            <ProviderPickerChip />
            <FolderPickerChip />
          </div>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="Send"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--adf-ui-accent)] text-[var(--adf-ui-on-accent)] transition-[opacity,background-color] duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-[var(--adf-ui-accent-hover)] disabled:opacity-35"
          >
            {busy ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-[12px] text-[var(--adf-ui-danger)]">{error}</p>}
      <div className="mt-1.5 flex items-center justify-between">
        <button
          type="button"
          onClick={toggleSuggestions}
          aria-pressed={suggestionsOn}
          className="rounded px-1 text-[10.5px] text-[var(--adf-ui-text-subtle)] transition-colors hover:text-[var(--adf-ui-text-muted)]"
        >
          {suggestionsOn ? 'Hide suggestions' : 'Show suggestions'}
        </button>
        <span className="text-[10.5px] text-[var(--adf-ui-text-subtle)]">
          {busy ? `Creating ${name || 'the agent'}…` : 'Create a new agent'}
        </span>
      </div>
      </div>
    </div>
  )
}
