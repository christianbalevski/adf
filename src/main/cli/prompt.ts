/**
 * Line prompts for the one-shot CLI (`adf pair`, `adf daemon pair`): the
 * question goes to stderr so stdout stays pipeable; answers come from stdin,
 * a terminal or a pipe. One readline interface for the process, so piped
 * answers are not lost between questions; null once stdin has ended.
 */

import { createInterface, type Interface } from 'node:readline'

export interface LinePrompt {
  ask(question: string): Promise<string | null>
  close(): void
}

export function stdinPrompt(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): LinePrompt {
  let rl: Interface | null = null
  let ended = false
  const lines: string[] = []
  const waiting: Array<(line: string | null) => void> = []
  const open = (): void => {
    if (rl || ended) return
    rl = createInterface({ input, terminal: false })
    rl.on('line', (line) => {
      const next = waiting.shift()
      if (next) next(line)
      else lines.push(line)
    })
    rl.on('close', () => {
      ended = true
      for (const w of waiting.splice(0)) w(null)
    })
  }
  return {
    ask(question: string): Promise<string | null> {
      output.write(question)
      open()
      const buffered = lines.shift()
      if (buffered !== undefined) return Promise.resolve(buffered)
      if (ended) return Promise.resolve(null)
      return new Promise(resolve => waiting.push(resolve))
    },
    close(): void {
      rl?.close()
      rl = null
    },
  }
}
