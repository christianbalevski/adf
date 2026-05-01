import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'

interface EditorToolbarProps {
  editor: Editor | null
  rawMode?: boolean
  onToggleRawMode?: () => void
}

export function EditorToolbar({ editor, rawMode, onToggleRawMode }: EditorToolbarProps) {
  // Force re-render on every editor transaction (selection change, typing, etc.)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!editor) return
    const onTransaction = () => setTick((t) => t + 1)
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction) }
  }, [editor])

  if (!editor) return null

  const btnClass = (active: boolean) =>
    `px-2 py-1 text-sm rounded ${
      active
        ? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-600 dark:text-neutral-100'
        : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700'
    }`

  const isInTable = editor.isActive('table')

  return (
    <div className="border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800">
      {/* Main toolbar */}
      <div className="flex items-center gap-1 px-4 py-1.5">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={btnClass(editor.isActive('bold'))}
          title="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={btnClass(editor.isActive('italic'))}
          title="Italic"
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={btnClass(editor.isActive('strike'))}
          title="Strikethrough"
        >
          <s>S</s>
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-600 mx-1" />
        <button
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
          className={btnClass(editor.isActive('heading', { level: 1 }))}
          title="Heading 1"
        >
          H1
        </button>
        <button
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          className={btnClass(editor.isActive('heading', { level: 2 }))}
          title="Heading 2"
        >
          H2
        </button>
        <button
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          className={btnClass(editor.isActive('heading', { level: 3 }))}
          title="Heading 3"
        >
          H3
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-600 mx-1" />
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={btnClass(editor.isActive('bulletList'))}
          title="Bullet List"
        >
          List
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={btnClass(editor.isActive('orderedList'))}
          title="Ordered List"
        >
          1. List
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={btnClass(editor.isActive('blockquote'))}
          title="Quote"
        >
          Quote
        </button>
        <button
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          className={btnClass(editor.isActive('codeBlock'))}
          title="Code Block"
        >
          Code
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-600 mx-1" />
        <button
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
          className={btnClass(editor.isActive('table'))}
          title="Insert Table"
        >
          Table
        </button>
        {onToggleRawMode && (
          <>
            <div className="flex-1" />
            <button
              onClick={onToggleRawMode}
              className={btnClass(!!rawMode)}
              title={rawMode ? 'Switch to rich editor' : 'View raw markdown'}
            >
              {rawMode ? 'Rich' : 'Raw'}
            </button>
          </>
        )}
      </div>

      {/* Table context toolbar — shown when cursor is inside a table */}
      {isInTable && (
        <div className="flex items-center gap-1 px-4 py-1 border-t border-neutral-100 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500 font-medium uppercase tracking-wider mr-1">Table</span>
          <button
            onClick={() => editor.chain().focus().addColumnBefore().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title="Add column before"
          >
            + Col Before
          </button>
          <button
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title="Add column after"
          >
            + Col After
          </button>
          <button
            onClick={() => editor.chain().focus().deleteColumn().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
            title="Delete column"
          >
            - Col
          </button>
          <div className="w-px h-3 bg-neutral-200 dark:bg-neutral-600 mx-0.5" />
          <button
            onClick={() => editor.chain().focus().addRowBefore().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title="Add row before"
          >
            + Row Before
          </button>
          <button
            onClick={() => editor.chain().focus().addRowAfter().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title="Add row after"
          >
            + Row After
          </button>
          <button
            onClick={() => editor.chain().focus().deleteRow().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
            title="Delete row"
          >
            - Row
          </button>
          <div className="w-px h-3 bg-neutral-200 dark:bg-neutral-600 mx-0.5" />
          <button
            onClick={() => editor.chain().focus().toggleHeaderRow().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title="Toggle header row"
          >
            Header
          </button>
          <button
            onClick={() => editor.chain().focus().deleteTable().run()}
            className="px-1.5 py-0.5 text-[11px] rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
            title="Delete entire table"
          >
            Delete Table
          </button>
        </div>
      )}
    </div>
  )
}
