import type { ModelMessage, SystemModelMessage } from 'ai'

export type PromptCacheProvider = 'anthropic' | 'openrouter'

/**
 * Claude only writes cache entries at explicit breakpoints. Keep one on the
 * system prompt and one at the end of persisted history, before per-call
 * instructions that disappear on the next request. These use two of the four
 * available breakpoints; a tool batch must receive only one, not one per result.
 * Clone the marked objects because converted messages are shared across calls.
 */
export function withPromptCacheBreakpoints(
  system: string | undefined,
  messages: ModelMessage[],
  provider: PromptCacheProvider | undefined,
): { system: string | SystemModelMessage | undefined; messages: ModelMessage[] } {
  if (!provider) return { system, messages }

  const mark = (options: ModelMessage['providerOptions']) => ({
    ...options,
    [provider]: { ...options?.[provider], cacheControl: { type: 'ephemeral' } },
  })
  const cachedSystem: SystemModelMessage | undefined = system
    ? { role: 'system', content: system, providerOptions: mark(undefined) }
    : undefined
  const cachedMessages = [...messages]
  for (let i = cachedMessages.length - 1; i >= 0; i--) {
    const message = cachedMessages[i]
    if (message.content.length === 0) continue
    if (message.role === 'tool') {
      // OpenRouter expands a tool message into one wire message per result.
      // Message-level options would therefore create too many breakpoints.
      let lastResult = message.content.length - 1
      while (lastResult >= 0 && message.content[lastResult].type !== 'tool-result') lastResult--
      if (lastResult < 0) continue
      const content = [...message.content]
      const part = content[lastResult]
      if (part.type !== 'tool-result') continue
      content[lastResult] = { ...part, providerOptions: mark(part.providerOptions) }
      cachedMessages[i] = { ...message, content }
    } else if (message.role === 'user' && Array.isArray(message.content)) {
      // OpenRouter applies message-level cache options only to text parts.
      // Mark the final part directly so image-only messages and media after
      // text are included in the reusable history prefix as well.
      const content = [...message.content]
      const last = content.length - 1
      content[last] = { ...content[last], providerOptions: mark(content[last].providerOptions) }
      cachedMessages[i] = { ...message, content }
    } else {
      cachedMessages[i] = { ...message, providerOptions: mark(message.providerOptions) }
    }
    break
  }
  return { system: cachedSystem, messages: cachedMessages }
}
