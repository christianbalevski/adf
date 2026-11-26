/** The part of noVNC's RFB client the browser Computer tab uses (@novnc/novnc ships no declarations). */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[] })
    scaleViewport: boolean
    resizeSession: boolean
    background: string
    disconnect(): void
  }
}
