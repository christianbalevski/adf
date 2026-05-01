import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { loadLanguage } from './codemirror-languages'
import { useAppStore } from '../../stores/app.store'

interface Props {
  filePath: string
  content: string
  onChange: (content: string) => void
  readOnly?: boolean
}

export function CodeMirrorEditor({ filePath, content, onChange, readOnly }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const isExternalUpdate = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const theme = useAppStore((s) => s.theme)

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
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isExternalUpdate.current) {
            onChangeRef.current(update.state.doc.toString())
          }
        })
      ]
    })

    const view = new EditorView({
      state,
      parent: containerRef.current
    })
    viewRef.current = view

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
    const currentDoc = view.state.doc.toString()
    if (content === currentDoc) return

    isExternalUpdate.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content }
    })
    isExternalUpdate.current = false
  }, [content])

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

  return <div ref={containerRef} className="cm-editor-container" />
}
