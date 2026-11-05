import { describe, it, expect } from 'vitest'
import { mcpCredentialRef } from '../../../src/shared/utils/mcp-config'

describe('mcpCredentialRef', () => {
  it('keys a credential by the server name, whatever the package', () => {
    expect(mcpCredentialRef({ name: 'gmail' }, 'API_KEY')).toBe('mcp:gmail:API_KEY')
    expect(mcpCredentialRef({ name: 'gmail-work', npm_package: '@x/gmail' } as { name: string }, 'API_KEY')).toBe('mcp:gmail-work:API_KEY')
  })
})
