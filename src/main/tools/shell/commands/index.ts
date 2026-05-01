/**
 * Command registry: maps command names to handlers.
 */

import type { CommandHandler } from './types'
import { filesystemHandlers } from './filesystem'
import { textHandlers } from './text'
import { structuredHandlers } from './structured'
import { messagingHandlers } from './messaging'
import { networkingHandlers } from './networking'
import { timerHandlers } from './timers'
import { codeHandlers } from './code'
import { mcpHandlers } from './mcp'
import { statusHandlers } from './status'
import { metaHandlers } from './meta'
import { helpHandler } from './help'

const registry = new Map<string, CommandHandler>()

function registerAll(handlers: CommandHandler[]): void {
  for (const handler of handlers) {
    registry.set(handler.name, handler)
    if (handler.aliases) {
      for (const alias of handler.aliases) {
        registry.set(alias, handler)
      }
    }
  }
}

// Register all command groups
registerAll(filesystemHandlers)
registerAll(textHandlers)
registerAll(structuredHandlers)
registerAll(messagingHandlers)
registerAll(networkingHandlers)
registerAll(timerHandlers)
registerAll(codeHandlers)
registerAll(mcpHandlers)
registerAll(statusHandlers)
registerAll(metaHandlers)
registerAll([helpHandler])

/** Look up a command handler by name */
export function getCommand(name: string): CommandHandler | undefined {
  return registry.get(name)
}

/** Get all unique registered handlers (no alias duplicates) */
export function getAllCommands(): CommandHandler[] {
  const seen = new Set<string>()
  const result: CommandHandler[] = []
  for (const handler of registry.values()) {
    if (!seen.has(handler.name)) {
      seen.add(handler.name)
      result.push(handler)
    }
  }
  return result
}

/** Check if a command name is registered */
export function hasCommand(name: string): boolean {
  return registry.has(name)
}

export { registry as commandRegistry }
