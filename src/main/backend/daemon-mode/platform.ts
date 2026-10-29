/**
 * Native UI capabilities used by the shared Studio daemon handlers. Electron
 * installs these at its entry point; the daemon's browser sessions deliberately
 * leave them absent and replace native-only channels with browser behavior.
 * Keeping Electron out of this module lets both hosts reuse the handler tables.
 */
type DesktopPlatform = Pick<typeof import('electron'), 'app' | 'BrowserWindow' | 'clipboard' | 'dialog' | 'nativeImage' | 'shell'>
let desktop: DesktopPlatform | null = null

export class DesktopCapabilityUnavailableError extends Error {
  readonly code = 'web_desktop_only'
  constructor(capability: string) {
    super(`${capability} requires the desktop Studio app.`)
    this.name = 'DesktopCapabilityUnavailableError'
  }
}

export function setDaemonDesktopPlatform(platform: DesktopPlatform): void {
  desktop = platform
}

function capability<K extends keyof DesktopPlatform>(name: K): DesktopPlatform[K] {
  // Calls preserve the Electron object's receiver (some native methods rely on it).
  return new Proxy(function () {}, {
    get(_target, property) {
      if (!desktop) throw new DesktopCapabilityUnavailableError(`${name}.${String(property)}`)
      const target = desktop[name]
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
    construct(_target, args) {
      if (!desktop) throw new DesktopCapabilityUnavailableError(name)
      return Reflect.construct(desktop[name] as unknown as new (...args: unknown[]) => object, args)
    },
  }) as unknown as DesktopPlatform[K]
}

export const app = capability('app')
export const BrowserWindow = capability('BrowserWindow')
export type BrowserWindow = Electron.BrowserWindow
export const clipboard = capability('clipboard')
export const dialog = capability('dialog')
export const nativeImage = capability('nativeImage')
export const shell = capability('shell')
