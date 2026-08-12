import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react'
import { getEditorExtensions } from './EditorExtensions'
import { EditorToolbar } from './EditorToolbar'
import { CodeMirrorEditor } from './CodeMirrorEditor'

const DEBUG = false // Set to true to enable verbose logging

// ProseMirror has no virtualization — it materializes every node into the DOM,
// so a big file blocks the main thread for tens of seconds. Past this size we
// open in source view (CodeMirror only renders the viewport) and let the user
// opt into rich mode from the toolbar.
const LARGE_MD_CHARS = 128_000

// Past this the parse is a hard multi-second freeze rather than a stutter, so
// asking for rich mode gets a confirmation instead of just doing it.
const CONFIRM_MD_CHARS = 512_000

// Re-serializing the whole document to markdown is O(doc); too expensive to do
// on every transaction.
const SERIALIZE_DEBOUNCE_MS = 250

interface MarkdownEditorProps {
  filePath: string
  content: string
  onChange: (content: string) => void
}

interface RichMarkdownViewProps {
  content: string
  onChange: (content: string) => void
  /** False while the source view is showing — don't parse into the hidden editor. */
  active: boolean
  onEditorChange: (editor: Editor | null) => void
  /** Filled with a "serialize now" callback so the parent can flush before switching views. */
  flushRef: MutableRefObject<(() => void) | null>
  /**
   * Asked before every push of externally-changed content. Returning true means
   * the parent has taken the document back to source view — don't parse it.
   */
  shouldGate: (next: string) => boolean
  /** Called once the rich view is showing `content` — clears "Rendering…". */
  onRendered: () => void
}

/**
 * The Tiptap half of the editor. Split out so it can be mounted lazily — a file
 * that opens in source view never pays the parse until rich mode is asked for.
 */
function RichMarkdownView({ content, onChange, active, onEditorChange, flushRef, shouldGate, onRendered }: RichMarkdownViewProps) {
  // Use a ref to always have access to the latest content in callbacks
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRenderedRef = useRef(onRendered)
  onRenderedRef.current = onRendered

  // TipTap builds the editor inside a useState initializer — i.e. during React's
  // render phase — unless told otherwise, and onCreate parses the document
  // synchronously from there. On a big file that means the click asking for rich
  // mode never paints and the app looks hung. Deferring moves creation into a
  // passive effect, after the "Rendering…" frame. Small files keep the original
  // in-render path so nothing flashes.
  const [deferCreate] = useState(() => contentRef.current.length > LARGE_MD_CHARS)

  // True from "we decided to push" until the push lands, so the render-settled
  // report below doesn't fire while the parse is still queued.
  const pushPending = useRef(false)

  // Tracks whether we are programmatically setting content (to avoid feedback loops)
  const isSettingContent = useRef(false)
  // Tracks content we've pushed to the editor, to avoid redundant setContent calls
  const lastPushedContent = useRef<string | null>(null)

  const serializeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSerialize = useRef<(() => void) | null>(null)

  const cancelSerialize = useCallback(() => {
    if (serializeTimer.current) clearTimeout(serializeTimer.current)
    serializeTimer.current = null
    pendingSerialize.current = null
  }, [])

  const flushSerialize = useCallback(() => {
    if (serializeTimer.current) clearTimeout(serializeTimer.current)
    serializeTimer.current = null
    const pending = pendingSerialize.current
    pendingSerialize.current = null
    pending?.()
  }, [])

  // Declared ahead of useEditor so this cleanup runs *before* Tiptap destroys the
  // instance — the pending serialize still has a live document to read.
  useEffect(() => {
    flushRef.current = flushSerialize
    return () => {
      flushRef.current = null
      flushSerialize()
    }
  }, [flushRef, flushSerialize])

  /**
   * Set markdown content in the editor.
   * Uses the Markdown extension's setContent with contentType option.
   */
  const setMarkdownContent = useCallback((editorInstance: Editor, markdown: string) => {
    if (DEBUG) console.log('[MarkdownEditor] setMarkdownContent called, markdown length:', markdown.length)

    // Percent-encode spaces in adf-file:// URLs so the markdown parser doesn't split on them
    const processed = markdown.replace(
      /adf-file:\/\/([^\s)>"'\]]+(?:\s[^\s)>"'\]]+)*)/g,
      (_match, path: string) => 'adf-file://' + path.replace(/ /g, '%20')
    )

    try {
      // Use the contentType option - this is the standard Tiptap v3 Markdown way
      editorInstance.commands.setContent(processed, {
        // @ts-expect-error - contentType is added by @tiptap/markdown extension
        contentType: 'markdown'
      })
      if (DEBUG) console.log('[MarkdownEditor] Content set successfully via contentType: markdown')

      // Verify content was set by checking editor state
      const currentHtml = editorInstance.getHTML()
      if (DEBUG) console.log('[MarkdownEditor] Editor HTML after setContent:', currentHtml.substring(0, 200))
    } catch (error) {
      console.error('[MarkdownEditor] setContent failed:', error)

      // Last resort fallback - try setting as HTML after basic markdown conversion
      try {
        // Very basic markdown to HTML for critical content
        const basicHtml = markdown
          .replace(/^### (.*$)/gim, '<h3>$1</h3>')
          .replace(/^## (.*$)/gim, '<h2>$1</h2>')
          .replace(/^# (.*$)/gim, '<h1>$1</h1>')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/\n/g, '<br>')
        editorInstance.commands.setContent(basicHtml)
        if (DEBUG) console.log('[MarkdownEditor] Content set via basic HTML fallback')
      } catch (fallbackError) {
        console.error('[MarkdownEditor] All setContent methods failed:', fallbackError)
      }
    }
  }, [])

  const editor = useEditor({
    immediatelyRender: !deferCreate,
    extensions: getEditorExtensions(),
    content: '',
    onCreate: ({ editor: editorInstance }) => {
      // Set initial content as markdown once the editor (and Markdown extension) is ready
      const initial = contentRef.current
      if (DEBUG) console.log('[MarkdownEditor] onCreate, content length:', initial?.length ?? 0)
      if (initial) {
        lastPushedContent.current = initial
        isSettingContent.current = true
        setMarkdownContent(editorInstance, initial)
        isSettingContent.current = false
      }
      onRenderedRef.current()
    },
    onUpdate: ({ editor: editorInstance }) => {
      // If we are in the middle of a programmatic setContent, ignore the onUpdate
      if (isSettingContent.current) return

      pendingSerialize.current = () => {
        if (editorInstance.isDestroyed) return
        const markdown = editorInstance.getMarkdown()
        lastPushedContent.current = markdown
        onChangeRef.current(markdown)
      }
      if (serializeTimer.current) clearTimeout(serializeTimer.current)
      serializeTimer.current = setTimeout(flushSerialize, SERIALIZE_DEBOUNCE_MS)
    },
    editorProps: {
      attributes: {
        class: 'tiptap'
      }
    }
  })

  // Hand the instance to the toolbar, which lives in the parent.
  useEffect(() => {
    onEditorChange(editor)
    return () => onEditorChange(null)
  }, [editor, onEditorChange])

  // When external content changes (agent write, file load, returning from source
  // view), push to editor. Deferred via setTimeout(0) so TipTap's synchronous
  // markdown parsing doesn't block the event loop during file switches — lets
  // pending promises and other effects complete first.
  useEffect(() => {
    if (DEBUG) console.log('[MarkdownEditor] useEffect triggered - editor:', !!editor, 'destroyed:', editor?.isDestroyed, 'content:', content?.length ?? 0)

    // Source view is showing: parsing into the hidden rich editor is the whole
    // cost we're avoiding.
    if (!active) return

    if (!editor || editor.isDestroyed) {
      if (DEBUG) console.log('[MarkdownEditor] useEffect: editor not ready, skipping')
      return
    }

    // Skip if unchanged
    if (content === lastPushedContent.current) {
      if (DEBUG) console.log('[MarkdownEditor] useEffect: content unchanged, skipping')
      return
    }

    // Everything that reaches here is content we did NOT produce, so this is
    // where the size gate has to be re-checked: an agent can grow a file past
    // the threshold while the tab is open, and parsing it is the freeze the gate
    // exists to prevent. lastPushedContent is deliberately left alone so the
    // push still happens if the user asks for rich mode afterwards.
    if (shouldGate(content)) return

    if (DEBUG) console.log('[MarkdownEditor] useEffect: syncing new content, length:', content?.length ?? 0, 'preview:', content?.substring(0, 100) ?? '(empty)')
    lastPushedContent.current = content

    // Incoming content supersedes any un-emitted local edit — dropping it keeps
    // us from writing stale text back over the new version.
    cancelSerialize()

    // Defer to next macrotask so the renderer event loop isn't blocked by TipTap parsing
    pushPending.current = true
    const handle = setTimeout(() => {
      pushPending.current = false
      if (editor.isDestroyed) return
      const t0 = performance.now()
      isSettingContent.current = true
      setMarkdownContent(editor, content || '')
      isSettingContent.current = false
      console.log(`[PERF:renderer] MarkdownEditor.setContent: ${(performance.now() - t0).toFixed(1)}ms (chars=${content?.length ?? 0})`)
      onRenderedRef.current()
    }, 0)

    return () => {
      pushPending.current = false
      clearTimeout(handle)
    }
  }, [content, active, editor, setMarkdownContent, cancelSerialize, shouldGate])

  // Report readiness on every render — the parent holds "Rendering…" from the
  // click until the rich view is actually showing the document.
  useEffect(() => {
    if (active && editor && !editor.isDestroyed && !pushPending.current) onRendered()
  })

  return <EditorContent editor={editor} />
}

export function MarkdownEditor({ filePath, content: externalContent, onChange }: MarkdownEditorProps) {
  const text = externalContent || ''
  // Re-evaluated on every render, not frozen at open: an agent can grow (or
  // empty) the file while the tab is open, and the gate has to follow it.
  const isLarge = text.length > LARGE_MD_CHARS

  const [rawMode, setRawMode] = useState(isLarge)
  // Rich editor is built on first request; a gated file never builds one unless asked.
  const [richMounted, setRichMounted] = useState(!isLarge)
  const [editor, setEditor] = useState<Editor | null>(null)
  // Set while TipTap parses, so the button that asked for it can show progress
  // instead of the whole app appearing to hang.
  const [rendering, setRendering] = useState(false)
  // Set when a huge file needs the user to say yes before we parse it.
  const [confirmPending, setConfirmPending] = useState(false)

  const richFlushRef = useRef<(() => void) | null>(null)
  const rawFlushRef = useRef<(() => void) | null>(null)
  // Consumed by the next gate check: the user explicitly asked for rich mode on
  // an oversized document, so that one push is allowed through.
  const gateOverrideRef = useRef(false)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const enterRichMode = useCallback((oversized: boolean) => {
    // Only arm the override when there is a gate to get past — leaving it set on
    // a small file would spend it on a later agent write instead.
    if (oversized) {
      gateOverrideRef.current = true
      setRendering(true)
    }
    setConfirmPending(false)
    setRichMounted(true)
    setRawMode(false)
  }, [])

  const handleToggleRawMode = useCallback(() => {
    // Flush both sides before switching so the view we're opening starts from
    // the text the user actually typed, not a 250ms-stale copy.
    richFlushRef.current?.()
    rawFlushRef.current?.()
    if (!rawMode) {
      setConfirmPending(false)
      setRawMode(true)
      return
    }
    if (text.length > CONFIRM_MD_CHARS) {
      // Multi-second freeze territory — make it a choice, not a surprise.
      setConfirmPending(true)
      return
    }
    enterRichMode(isLarge)
  }, [rawMode, text.length, isLarge, enterRichMode])

  const handleContentChange = useCallback((value: string) => {
    onChangeRef.current(value)
  }, [])

  // Asked by the rich view before it parses anything it didn't produce itself.
  const shouldGate = useCallback((next: string) => {
    if (next.length <= LARGE_MD_CHARS) return false
    if (gateOverrideRef.current) {
      gateOverrideRef.current = false
      return false
    }
    // Grew past the gate while open. Hand the document back to source view
    // rather than paying the parse the gate was added to avoid.
    setRawMode(true)
    setRendering(false)
    return true
  }, [])

  const onRendered = useCallback(() => setRendering(false), [])

  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-900">
      <EditorToolbar editor={editor} rawMode={rawMode} onToggleRawMode={handleToggleRawMode} />
      {rendering && (
        <div className="px-4 py-1 text-[11px] text-blue-600 dark:text-blue-300 border-b border-neutral-200 dark:border-neutral-700 bg-blue-50 dark:bg-blue-900/30">
          Rendering rich text ({Math.round(text.length / 1024).toLocaleString()} KB) — the window will be unresponsive until it finishes.
        </div>
      )}
      {confirmPending && (
        <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-neutral-600 dark:text-neutral-300 border-b border-neutral-200 dark:border-neutral-700 bg-amber-50 dark:bg-amber-900/20">
          <span>
            Rendering {Math.round(text.length / 1024).toLocaleString()} KB as rich text will freeze the window for tens of seconds.
          </span>
          <button onClick={() => enterRichMode(true)} className="px-1.5 py-0.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-700">
            Render anyway
          </button>
          <button onClick={() => setConfirmPending(false)} className="px-1.5 py-0.5 rounded border border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-700">
            Cancel
          </button>
        </div>
      )}
      {isLarge && rawMode && !rendering && !confirmPending && (
        <div className="px-4 py-1 text-[11px] text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50">
          Large file ({Math.round(text.length / 1024).toLocaleString()} KB) — showing source. Rich text would take tens of seconds to render.
        </div>
      )}
      <div className={rawMode ? 'flex-1 overflow-hidden' : 'flex-1 overflow-y-auto'}>
        {rawMode && (
          <CodeMirrorEditor
            filePath={filePath}
            content={text}
            onChange={handleContentChange}
            flushRef={rawFlushRef}
          />
        )}
        {richMounted && (
          // Kept mounted (just hidden) while in source view so toggling back
          // doesn't re-parse the document or lose undo history.
          <div className={rawMode ? 'hidden' : undefined}>
            <RichMarkdownView
              content={text}
              onChange={handleContentChange}
              active={!rawMode}
              onEditorChange={setEditor}
              flushRef={richFlushRef}
              shouldGate={shouldGate}
              onRendered={onRendered}
            />
          </div>
        )}
      </div>
    </div>
  )
}
