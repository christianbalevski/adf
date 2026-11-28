/**
 * The right-click menu on text in every Studio window: spelling suggestions,
 * Add to Dictionary, Cut/Copy/Paste/Select All, Copy Link.
 *
 * Electron has no default context menu. Renderer components that own their
 * right-clicks (sidebar rows, loop tabs, the mesh canvas) call
 * preventDefault() on `contextmenu`, which stops the webContents
 * 'context-menu' event, so this menu only appears where nothing else did.
 *
 * Spell checking itself: macOS and Windows use the OS checker; Linux uses
 * Hunspell, whose dictionaries download only on request
 * (services/spellcheck-dictionaries.service.ts). Without one, Linux shows no
 * suggestions and the rest of the menu still works.
 */

import { BrowserWindow, Menu, clipboard, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'

/** The parts of ContextMenuParams the menu reads. */
export type ContextMenuInput = Pick<
  ContextMenuParams,
  'isEditable' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'linkURL' | 'editFlags'
>

/** Edit commands go to the clicked page, not the focused window (macOS can right-click a background window). */
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface ContextMenuActions {
  edit(command: EditCommand): void
  replaceMisspelling(word: string): void
  addToDictionary(word: string): void
  copyText(text: string): void
}

/** What the app menu's redo role binds on each platform. */
const REDO_ACCELERATOR: Partial<Record<NodeJS.Platform, string>> = { darwin: 'Shift+Cmd+Z', win32: 'Ctrl+Y' }

/** The menu for one right-click; empty means show nothing. */
export function contextMenuTemplate(params: ContextMenuInput, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = []

  // Chromium reports a misspelling only in editable content, with at most five suggestions.
  if (params.misspelledWord) {
    const suggestions: MenuItemConstructorOptions[] = params.dictionarySuggestions.map((word) => ({ label: word, click: () => actions.replaceMisspelling(word) }))
    if (suggestions.length === 0) suggestions.push({ label: 'No Suggestions', enabled: false })
    const word = params.misspelledWord
    suggestions.push({ label: 'Add to Dictionary', click: () => actions.addToDictionary(word) })
    groups.push(suggestions)
  }

  // CmdOrCtrl renders as ⌘ on macOS and Ctrl elsewhere; in a popup it is a hint only.
  const item = (label: string, command: EditCommand, accelerator: string, enabled = true): MenuItemConstructorOptions =>
    ({ label, accelerator, enabled, click: () => actions.edit(command) })

  if (params.isEditable) {
    const f = params.editFlags
    groups.push([
      item('Undo', 'undo', 'CmdOrCtrl+Z', f.canUndo),
      item('Redo', 'redo', REDO_ACCELERATOR[process.platform] ?? 'Ctrl+Shift+Z', f.canRedo)
    ])
    groups.push([
      item('Cut', 'cut', 'CmdOrCtrl+X', f.canCut),
      item('Copy', 'copy', 'CmdOrCtrl+C', f.canCopy),
      item('Paste', 'paste', 'CmdOrCtrl+V', f.canPaste),
      item('Select All', 'selectAll', 'CmdOrCtrl+A', f.canSelectAll)
    ])
  } else if (params.selectionText.trim()) {
    groups.push([item('Copy', 'copy', 'CmdOrCtrl+C')])
  }

  if (params.linkURL) {
    const url = params.linkURL
    groups.push([{ label: 'Copy Link', click: () => actions.copyText(url) }])
  }

  return groups.flatMap((group, i) => (i === 0 ? group : [{ type: 'separator' as const }, ...group]))
}

/** Give a window's page the text context menu. Not for webview guests: noVNC sends right-clicks to the remote desktop. */
export function attachContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, {
      edit: (command) => contents[command](),
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      copyText: (text) => clipboard.writeText(text)
    })
    if (template.length === 0) return
    // Over the window that was clicked, at the cursor; opened from the keyboard
    // (Shift+F10, the Menu key), at the field instead.
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(contents) ?? undefined,
      ...(params.menuSourceType === 'keyboard' ? { x: params.x, y: params.y } : {})
    })
  })
}
