import { EventEmitter } from 'node:events'
import React from 'react'
import { Box, render, measureElement, type DOMElement } from 'ink'
import { ThemeContext, createTheme } from '../../../src/main/tui/app/theme'
import { TranscriptItemView } from '../../../src/main/tui/views/chat/Transcript'
import type { AssistantItem } from '../../../src/main/tui/state/types'
import { isControlOnly } from './render'

class Output extends EventEmitter {
  isTTY = true
  columns = 120
  rows = 34
  frame = ''
  write = (chunk: string) => { if (!isControlOnly(chunk)) this.frame = chunk; return true }
}
class Input extends EventEmitter {
  isTTY = true
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null
}
export const prose = (count: number) => Array.from({ length: count }, (_, i) => `Paragraph ${i}: The assistant explains a result with **important context**, a \`code reference\`, and sufficient text to wrap across terminal columns. ` + 'This is representative plain English terminal output. '.repeat(3)).join('\n\n')
export interface MarkdownFrame {
  text: string
  width?: number
  height?: number
  clip?: number
  selected?: boolean
  mono?: boolean
}

/** Real Ink mount, with an inspectable node tree and complete terminal frames. */
export function mountMarkdown(initial: MarkdownFrame, windowed: boolean) {
  const output = new Output()
  let root: DOMElement | null = null
  const themes = [createTheme({ mono: true }), createTheme({ mono: false })]
  const view = ({ text, width = 118, height = 28, clip = 0, selected = false, mono = true }: MarkdownFrame) => {
    const item: AssistantItem = { id: 'live', at: 1, kind: 'assistant', text, streaming: true }
    return <ThemeContext.Provider value={themes[mono ? 0 : 1]}><Box ref={node => { root = node }} width={width} height={height} overflow="hidden" justifyContent="flex-end" flexDirection="column"><Box flexDirection="column" flexShrink={0} marginBottom={-clip}><TranscriptItemView item={item} width={width} selected={selected} expanded={false} showThinking={false} queued={false} viewportHeight={windowed ? height : undefined} clipBottom={clip} /></Box></Box></ThemeContext.Provider>
  }
  const instance = render(view(initial), { stdout: output as unknown as NodeJS.WriteStream, stdin: new Input() as unknown as NodeJS.ReadStream, stderr: output as unknown as NodeJS.WriteStream, debug: true, interactive: true, exitOnCtrlC: false, patchConsole: false })
  const count = (node: { childNodes?: unknown[] }): number => 1 + (node.childNodes ?? []).reduce<number>((n, child) => n + count(child as { childNodes?: unknown[] }), 0)
  return {
    async update(frame: MarkdownFrame) { instance.rerender(view(frame)); await instance.waitUntilRenderFlush(); return output.frame },
    async ready() { await instance.waitUntilRenderFlush(); return output.frame },
    nodes: () => root ? count(root) : 0,
    height: () => root?.childNodes[0] ? measureElement(root.childNodes[0] as DOMElement).height : 0,
    unmount: () => { instance.unmount(); instance.cleanup() },
  }
}
