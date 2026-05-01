import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { isAdfFileUrl, openAdfFileLink } from '../../utils/open-adf-link'

// Extend Image so resized dimensions persist through markdown round-trips.
// When width/height are set, serialize as <img> HTML (which parseHTML handles).
// Otherwise use standard ![alt](src) markdown.
/** Percent-encode spaces in adf-file:// URLs for valid markdown/HTML. */
function encodeAdfSrc(src: string): string {
  if (src.startsWith('adf-file://')) {
    return 'adf-file://' + src.slice('adf-file://'.length).replace(/ /g, '%20')
  }
  return src
}

const ResizableImage = Image.extend({
  renderMarkdown: (node) => {
    const src = encodeAdfSrc(node.attrs?.src ?? '')
    const alt = node.attrs?.alt ?? ''
    const title = node.attrs?.title ?? ''
    const width = node.attrs?.width
    const height = node.attrs?.height

    if (width || height) {
      const parts = [`<img src="${src}"`]
      if (alt) parts.push(`alt="${alt}"`)
      if (title) parts.push(`title="${title}"`)
      if (width) parts.push(`width="${width}"`)
      if (height) parts.push(`height="${height}"`)
      return parts.join(' ') + '>'
    }

    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`
  }
}).configure({
  allowBase64: true,
  resize: {
    enabled: true,
    alwaysPreserveAspectRatio: true,
    minWidth: 50,
    minHeight: 50
  }
})

/** Intercept double-clicks on <a> tags: adf-file:// opens in editor tab, http(s) opens externally. */
const LinkClickHandler = Extension.create({
  name: 'adfLinkClickHandler',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('adfLinkClick'),
        props: {
          handleDoubleClick(_view, _pos, event) {
            const anchor = (event.target as HTMLElement).closest('a[href]')
            if (!anchor) return false

            const href = anchor.getAttribute('href')
            if (!href) return false

            if (isAdfFileUrl(href)) {
              event.preventDefault()
              openAdfFileLink(href)
              return true
            }

            if (href.startsWith('http://') || href.startsWith('https://')) {
              event.preventDefault()
              window.open(href, '_blank')
              return true
            }

            return false
          }
        }
      })
    ]
  }
})

export function getEditorExtensions() {
  return [
    StarterKit,
    TableKit.configure({
      table: {
        resizable: false
      }
    }),
    ResizableImage,
    Placeholder.configure({
      placeholder: 'Start writing...'
    }),
    Markdown,
    LinkClickHandler
  ]
}
