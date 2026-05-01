import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { hasCommand } from '../../../src/main/tools/shell/commands/index'

describe('audit tool registry — archive_read must not exist', () => {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)

  it('archive_read tool is not registered', () => {
    expect(registry.get('archive_read')).toBeUndefined()
  })

  it('archive_read does not appear in the full tool list', () => {
    const allNames = registry.getAll().map((t) => t.name)
    expect(allNames).not.toContain('archive_read')
  })

  it('archive is not a registered shell command', () => {
    expect(hasCommand('archive')).toBe(false)
    expect(hasCommand('archive_read')).toBe(false)
  })
})
