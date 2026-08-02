import type { HTMLAttributes, DetailedHTMLProps, Ref } from 'react'

/** Electron <webview> tag (enabled via webviewTag: true on the BrowserWindow). */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
          ref?: Ref<HTMLElement>
        },
        HTMLElement
      >
    }
  }
}
