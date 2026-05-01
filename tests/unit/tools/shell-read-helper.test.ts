import { describe, it, expect, vi } from 'vitest'
import { shellReadFile } from '../../../src/main/tools/shell/commands/fs-read-helper'

function fakeRegistry(response: { content: string; isError: boolean }) {
  return {
    executeTool: vi.fn(async () => response),
  }
}

describe('shellReadFile', () => {
  it('returns content on success', async () => {
    const registry = fakeRegistry({
      content: JSON.stringify({ content: 'hello' }),
      isError: false,
    })
    const [content, error] = await shellReadFile(registry as any, {} as any, 'test.txt')
    expect(content).toBe('hello')
    expect(error).toBeNull()
  })

  it('returns empty string for empty content', async () => {
    const registry = fakeRegistry({
      content: JSON.stringify({ content: '' }),
      isError: false,
    })
    const [content, error] = await shellReadFile(registry as any, {} as any, 'test.txt')
    expect(content).toBe('')
    expect(error).toBeNull()
  })

  it('returns empty string when content key is missing', async () => {
    const registry = fakeRegistry({
      content: JSON.stringify({}),
      isError: false,
    })
    const [content, error] = await shellReadFile(registry as any, {} as any, 'test.txt')
    expect(content).toBe('')
    expect(error).toBeNull()
  })

  it('returns error message on tool error', async () => {
    const registry = fakeRegistry({
      content: 'File not found',
      isError: true,
    })
    const [content, error] = await shellReadFile(registry as any, {} as any, 'missing.txt')
    expect(content).toBeNull()
    expect(error).toBe('File not found')
  })

  it('returns error for invalid JSON response', async () => {
    const registry = fakeRegistry({
      content: 'not json at all',
      isError: false,
    })
    const [content, error] = await shellReadFile(registry as any, {} as any, 'test.txt')
    expect(content).toBeNull()
    expect(error).toBe('Failed to parse fs_read result')
  })

  it('passes line range options to executeTool', async () => {
    const registry = fakeRegistry({
      content: JSON.stringify({ content: 'line 5' }),
      isError: false,
    })
    await shellReadFile(registry as any, {} as any, 'test.txt', { start_line: 5, end_line: 10 })
    expect(registry.executeTool).toHaveBeenCalledWith(
      'fs_read',
      { path: 'test.txt', start_line: 5, end_line: 10 },
      expect.anything(),
    )
  })

  it('omits undefined options from input', async () => {
    const registry = fakeRegistry({
      content: JSON.stringify({ content: 'all' }),
      isError: false,
    })
    await shellReadFile(registry as any, {} as any, 'test.txt')
    const callInput = registry.executeTool.mock.calls[0][1]
    expect(callInput).toEqual({ path: 'test.txt' })
    expect(callInput).not.toHaveProperty('start_line')
    expect(callInput).not.toHaveProperty('end_line')
  })
})
