import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdfFile } from '../../hooks/useAdfFile'
import { useAppStore } from '../../stores/app.store'
import { pickSuggestions } from './suggestions'
import { SuggestionMarquee } from './SuggestionMarquee'
import { FolderPickerChip, ProviderPickerChip } from './HomePickers'
import { useHomeProviders } from './HomeProviders'
import { NameChip } from './NameChip'
import { generateAgentName } from '../../../shared/utils/agent-names'

const MAX_ROWS = 8
/** Caption lines by roll count, highest first so one click shows one line. */
const SPIN_LINES: ReadonlyArray<readonly [number, string]> = [
  [15, "Ok chill! This thing was vibe coded, don't break it!"],
  [12, 'I guess not lol'],
  [8, "Can't find what you're looking for? Maybe the next spin will be it"],
  [4, 'You can rename it later.'],
]
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
export function HomeComposer() {
  const { createQuickAgent } = useAdfFile()
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const setChatPlacement = useAppStore((s) => s.setChatPlacement)
  const setCenterChatTabActive = useAppStore((s) => s.setCenterChatTabActive)
  // The provider the chip shows: an explicit pick, else the app default.
  // The create call gets exactly that, so what the user sees is what the
  // agent starts on (the settings template's provider never wins silently).
  const { selectedId: providerId } = useHomeProviders()
  const homeFolder = useAppStore((s) => s.homeFolder)
  const homeName = useAppStore((s) => s.homeName)
  const setHomeName = useAppStore((s) => s.setHomeName)
  // A name is drawn the first time the composer shows and kept until a send.
  useEffect(() => { if (!homeName) setHomeName(generateAgentName()) }, [homeName, setHomeName])
  const name = homeName ?? ''
  // The caption reacts to how many times the name has been rolled for this
  // agent: the obvious at four, then a nudge, a shrug, and a plea. Each line
  // once per agent, and the count resets with every send.
  const spins = useRef(0)
  const [hint, setHint] = useState<string | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = useRef<Set<number>>(new Set())
  const onSpin = useCallback(() => {
    spins.current += 1
    const say = (at: number, line: string) => {
      if (spins.current < at || shown.current.has(at)) return
      shown.current.add(at)
      setHint(line)
      if (hintTimer.current) clearTimeout(hintTimer.current)
      hintTimer.current = setTimeout(() => setHint(null), 5000)
    }
    for (const [at, line] of SPIN_LINES) say(at, line)
  }, [])
  // A typed name that is not a file name is refused; the caption says why.
  const onInvalidName = useCallback((reason: string) => {
    setHint(reason)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), 5000)
  }, [])
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

  const send = useCallback(async () => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await createQuickAgent(message, { providerId: providerId ?? undefined, folder: homeFolder ?? undefined, name: homeName ?? undefined, files: files.length > 0 ? files : undefined })
      if (!result.success) {
        setError(result.error ?? 'Could not create the agent')
        return
      }
      setText('')
      setFiles([])
      // The next agent gets its own name.
      setHomeName(generateAgentName())
      spins.current = 0
      shown.current.clear()
      setShowMeshGraph(false)
      // The loop takes the stage: the agent's first turn is the whole point
      // of the screen the user is about to see.
      setChatPlacement('center')
      setCenterChatTabActive(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, createQuickAgent, files, homeFolder, homeName, providerId, setCenterChatTabActive, setChatPlacement, setFiles, setHomeName, setShowMeshGraph, setText, text])

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
        className={`home-composer relative rounded-2xl border bg-[var(--adf-ui-surface)] shadow-sm transition-colors focus-within:border-[var(--adf-ui-accent)] ${dragOver ? 'border-[var(--adf-ui-accent)]' : 'border-[var(--adf-ui-border)]'}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false) }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) addFiles(e.dataTransfer.files) }}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--adf-ui-accent-subtle)] text-sm font-medium text-[var(--adf-ui-accent)]">
            Drop to attach
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2 py-1 text-[11px] text-[var(--adf-ui-text-muted)]">
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
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--adf-ui-text-muted)] transition-colors hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] disabled:opacity-40"
            >
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden>
                <path d="M9 3.25v11.5M3.25 9h11.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
            {name && <NameChip name={name} onChange={setHomeName} onSpin={onSpin} onInvalid={onInvalidName} />}
            <ProviderPickerChip />
            <FolderPickerChip />
          </div>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="Send"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--adf-ui-accent)] text-white transition-opacity disabled:opacity-35 dark:text-neutral-950"
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
        <span className="text-[10.5px] text-[var(--adf-ui-text-subtle)]">
          {busy
            ? `Creating ${name || 'the agent'}…`
            : hint ?? 'Each message here starts a new agent.'}
        </span>
        <button
          type="button"
          onClick={toggleSuggestions}
          aria-pressed={suggestionsOn}
          className="rounded px-1 text-[10.5px] text-[var(--adf-ui-text-subtle)] transition-colors hover:text-[var(--adf-ui-text-muted)]"
        >
          {suggestionsOn ? 'Hide suggestions' : 'Show suggestions'}
        </button>
      </div>
      </div>
    </div>
  )
}
