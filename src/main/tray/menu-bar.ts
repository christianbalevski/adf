/**
 * The macOS menu bar icon (Electron Tray).
 *
 * The content rules live in menu-bar-model.ts; this file is only the Electron
 * half: creating and destroying the Tray, rebuilding the menu from a fresh
 * snapshot each time it opens, and routing clicks back to the host.
 *
 * The menu is popped up on click rather than attached with setContextMenu: an
 * attached menu is a frozen copy, and keeping it current would mean rebuilding
 * on every agent state change. Building on click reads the live state once,
 * exactly when someone looks.
 */

import { Menu, Tray, nativeImage } from 'electron'
import { buildMenuBarModel, type MenuBarAction, type MenuBarItem, type MenuBarSnapshot } from './menu-bar-model'

export interface MenuBarHost {
  iconPath: string
  getSnapshot: () => MenuBarSnapshot
  onAction: (action: MenuBarAction) => void
}

export class MenuBarController {
  private tray: Tray | null = null

  constructor(private readonly host: MenuBarHost) {}

  /** Create or destroy the icon. Idempotent, so the settings toggle can call it freely. */
  setEnabled(enabled: boolean): void {
    if (enabled && !this.tray) {
      const icon = nativeImage.createFromPath(this.host.iconPath)
      icon.setTemplateImage(true)
      this.tray = new Tray(icon)
      const open = (): void => this.popUp()
      this.tray.on('click', open)
      this.tray.on('right-click', open)
      this.refresh()
    } else if (!enabled && this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  /** Update the title and tooltip. Cheap — call it on every approvals change. */
  refresh(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    const model = buildMenuBarModel(this.host.getSnapshot())
    this.tray.setTitle(model.title)
    this.tray.setToolTip(model.tooltip)
  }

  dispose(): void {
    this.setEnabled(false)
  }

  private popUp(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    const model = buildMenuBarModel(this.host.getSnapshot())
    this.tray.setTitle(model.title)
    this.tray.setToolTip(model.tooltip)
    this.tray.popUpContextMenu(Menu.buildFromTemplate(model.items.map((item) => this.toTemplate(item))))
  }

  private toTemplate(item: MenuBarItem): Electron.MenuItemConstructorOptions {
    switch (item.kind) {
      case 'separator':
        return { type: 'separator' }
      case 'info':
        return { label: item.label, enabled: false }
      case 'action':
        return {
          label: item.label,
          toolTip: item.toolTip,
          click: () => this.host.onAction(item.action)
        }
    }
  }
}
