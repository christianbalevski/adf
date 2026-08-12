import { useEffect, useRef, useCallback, type MutableRefObject } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { loadLanguage } from './codemirror-languages'
import { useAppStore } from '../../stores/app.store'

// Stringifying the whole doc on every keystroke is the expensive part of the
// change path; debounce it and flush on any teardown.
const CHANGE_DEBOUNCE_MS = 250

interface Props {
  filePath: string
  content: string
  onChange: (content: string) => void
  readOnly?: boolean
  /** Soft-wrap long lines (default true). Toggles live via a compartment. */
  lineWrap?: boolean
  /** Filled with an "emit now" callback so a parent can flush before swapping views. */
  flushRef?: MutableRefObject<(() => void) | null>
}

export function CodeMirrorEditor({ filePath, content, onChange, readOnly, lineWrap = true, flushRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const lineWrapCompartment = useRef(new Compartment())
  const isExternalUpdate = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const theme = useAppStore((s) => s.theme)

  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasPendingChange = useRef(false)
  // The document text we last handed to (or took from) the parent. The external
  // sync below compares against THIS, never against the live document: the emit
  // is debounced, so a keystroke can land between "emit" and the prop coming
  // back, and a live-doc comparison would read that keystroke as an external
  // write and dispatch the pre-keystroke text over it. Mirrors
  // MarkdownEditor's lastPushedContent.
  const lastSynced = useRef<string | null>(null)

  const cancelPendingChange = useCallback(() => {
    if (changeTimer.current) clearTimeout(changeTimer.current)
    changeTimer.current = null
    hasPendingChange.current = false
  }, [])

  // Reads the doc at flush time rather than at keystroke time — that's where the cost is.
  const flushChange = useCallback(() => {
    if (changeTimer.current) clearTimeout(changeTimer.current)
    changeTimer.current = null
    if (!hasPendingChange.current) return
    hasPendingChange.current = false
    // viewRef is nulled immediately after destroy(), so a live ref is enough.
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc.toString()
    lastSynced.current = doc
    onChangeRef.current(doc)
  }, [])

  useEffect(() => {
    if (!flushRef) return
    flushRef.current = flushChange
    return () => { flushRef.current = null }
  }, [flushRef, flushChange])

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return

    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        indentOnInput(),
        closeBrackets(),
        autocompletion(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...closeBracketsKeymap,
          indentWithTab
        ]),
        themeCompartment.current.of(isDark ? oneDark : []),
        languageCompartment.current.of([]),
        readOnlyCompartment.current.of(EditorState.readOnly.of(!!readOnly)),
        lineWrapCompartment.current.of(lineWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || isExternalUpdate.current) return
          hasPendingChange.current = true
          if (changeTimer.current) clearTimeout(changeTimer.current)
          changeTimer.current = setTimeout(flushChange, CHANGE_DEBOUNCE_MS)
        })
      ]
    })

    const view = new EditorView({
      state,
      parent: containerRef.current
    })
    viewRef.current = view
    // The doc starts as the prop, so the first sync pass has nothing to do.
    lastSynced.current = content

    // Load language support
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    loadLanguage(ext).then((lang) => {
      if (lang && !view.destroyed) {
        view.dispatch({
          effects: languageCompartment.current.reconfigure(lang)
        })
      }
    })

    return () => {
      // Never drop keystrokes typed inside the debounce window.
      flushChange()
      view.destroy()
      viewRef.current = null
    }
    // Only recreate on filePath change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath])

  // Sync external content changes
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.destroyed) return
    // Our own echo — the prop came back from a flush we made. Comparing against
    // the live doc here would treat any keystroke typed since that flush as a
    // conflict and clobber it.
    if (content === lastSynced.current) return
    lastSynced.current = content

    // The incoming write replaces the doc anyway; drop any un-emitted local edit
    // so the debounce can't write stale text back over it.
    cancelPendingChange()
    isExternalUpdate.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content }
    })
    isExternalUpdate.current = false
  }, [content, cancelPendingChange])

  // React to theme changes (including OS preference changes when theme is 'system')
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.destroyed) return

    const applyDark = (isDark: boolean) => {
      view.dispatch({
        effects: themeCompartment.current.reconfigure(isDark ? oneDark : [])
      })
    }

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyDark(mq.matches)
      const handler = (e: MediaQueryListEvent) => {
        if (!view.destroyed) applyDark(e.matches)
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      applyDark(theme === 'dark')
    }
  }, [theme])

  // React to readOnly changes
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.destroyed) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(!!readOnly))
    })
  }, [readOnly])

  // React to line-wrap changes
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.destroyed) return
    view.dispatch({
      effects: lineWrapCompartment.current.reconfigure(lineWrap ? EditorView.lineWrapping : [])
    })
  }, [lineWrap])

  return <div ref={containerRef} className="cm-editor-container" />
}
