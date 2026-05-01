import { useEditor, EditorContent } from '@tiptap/react'
import { useEffect, useRef, useCallback, useState } from 'react'
import { getEditorExtensions } from './EditorExtensions'
import { EditorToolbar } from './EditorToolbar'

const DEBUG = false // Set to true to enable verbose logging

interface MarkdownEditorProps {
  content: string
  onChange: (content: string) => void
}

export function MarkdownEditor({ content: externalContent, onChange }: MarkdownEditorProps) {
  const [rawMode, setRawMode] = useState(false)

  // Use a ref to always have access to the latest content in callbacks
  const contentRef = useRef(externalContent)
  contentRef.current = externalContent
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Tracks whether we are programmatically setting content (to avoid feedback loops)
  const isSettingContent = useRef(false)
  // Tracks content we've pushed to the editor, to avoid redundant setContent calls
  const lastPushedContent = useRef<string | null>(null)

  // Debug: log store content changes
  if (DEBUG) console.log('[MarkdownEditor] Render - content length:', externalContent?.length ?? 0, 'lastPushed:', lastPushedContent.current?.length ?? 0)

  /**
   * Set markdown content in the editor.
   * Uses the Markdown extension's setContent with contentType option.
   */
  const setMarkdownContent = useCallback((editorInstance: NonNullable<typeof editor>, markdown: string) => {
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
    extensions: getEditorExtensions(),
    content: '',
    onCreate: ({ editor: editorInstance }) => {
      // Set initial content as markdown once the editor (and Markdown extension) is ready
      const content = contentRef.current
      if (DEBUG) console.log('[MarkdownEditor] onCreate, content length:', content?.length ?? 0)
      if (content) {
        lastPushedContent.current = content
        isSettingContent.current = true
        setMarkdownContent(editorInstance, content)
        isSettingContent.current = false
      }
    },
    onUpdate: ({ editor: editorInstance }) => {
      // If we are in the middle of a programmatic setContent, ignore the onUpdate
      if (isSettingContent.current) return

      const markdown = editorInstance.getMarkdown()
      lastPushedContent.current = markdown

      onChangeRef.current(markdown)
    },
    editorProps: {
      attributes: {
        class: 'tiptap'
      }
    }
  })

  // When external content changes (agent write, file load, tab switch), push to editor.
  // Deferred via setTimeout(0) so TipTap's synchronous markdown parsing doesn't block the
  // event loop during file switches — lets pending promises and other effects complete first.
  useEffect(() => {
    if (DEBUG) console.log('[MarkdownEditor] useEffect triggered - editor:', !!editor, 'destroyed:', editor?.isDestroyed, 'content:', externalContent?.length ?? 0)

    if (!editor || editor.isDestroyed) {
      if (DEBUG) console.log('[MarkdownEditor] useEffect: editor not ready, skipping')
      return
    }

    // Skip if unchanged
    if (externalContent === lastPushedContent.current) {
      if (DEBUG) console.log('[MarkdownEditor] useEffect: content unchanged, skipping')
      return
    }

    if (DEBUG) console.log('[MarkdownEditor] useEffect: syncing new content, length:', externalContent?.length ?? 0, 'preview:', externalContent?.substring(0, 100) ?? '(empty)')
    lastPushedContent.current = externalContent

    // Defer to next macrotask so the renderer event loop isn't blocked by TipTap parsing
    const handle = setTimeout(() => {
      if (editor.isDestroyed) return
      const t0 = performance.now()
      isSettingContent.current = true
      setMarkdownContent(editor, externalContent || '')
      isSettingContent.current = false
      console.log(`[PERF:renderer] MarkdownEditor.setContent: ${(performance.now() - t0).toFixed(1)}ms (chars=${externalContent?.length ?? 0})`)
    }, 0)

    return () => clearTimeout(handle)
  }, [externalContent, editor, setMarkdownContent])

  // When switching from raw → rich, sync textarea edits back into the editor
  const handleToggleRawMode = useCallback(() => {
    setRawMode((prev) => {
      if (prev && editor && !editor.isDestroyed) {
        // Leaving raw mode: push current content into the rich editor
        const content = contentRef.current || ''
        lastPushedContent.current = content
        isSettingContent.current = true
        setMarkdownContent(editor, content)
        isSettingContent.current = false
      }
      return !prev
    })
  }, [editor, setMarkdownContent])

  const handleRawChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    lastPushedContent.current = value
    onChangeRef.current(value)
  }, [])

  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-900">
      <EditorToolbar editor={editor} rawMode={rawMode} onToggleRawMode={handleToggleRawMode} />
      <div className="flex-1 overflow-y-auto">
        {rawMode ? (
          <textarea
            className="w-full h-full resize-none outline-none p-8 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-mono text-sm leading-relaxed"
            value={externalContent || ''}
            onChange={handleRawChange}
            spellCheck={false}
          />
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
    </div>
  )
}
