import { describe, it, expect } from 'vitest'
import { mcpCredentialNamespace, mcpCredentialRef } from '../../../src/shared/utils/mcp-config'

describe('mcpCredentialNamespace', () => {
  it('uses the npm package for both config shapes', () => {
    expect(mcpCredentialNamespace({ name: 'srv', npm_package: '@scope/pkg' })).toBe('@scope/pkg')
    expect(mcpCredentialNamespace({ name: 'srv', npmPackage: '@scope/pkg' })).toBe('@scope/pkg')
  })

  // The credential panel stores keys under `npmPackage || pypiPackage || name`.
  // An agent config for a pypi-only server has no npm_package key at all, so the
  // namespace must not depend on that key being present.
  it('uses the pypi package when an agent config has no npm_package key', () => {
    expect(mcpCredentialNamespace({ name: 'srv', pypi_package: 'mcp-server-x' })).toBe('mcp-server-x')
    expect(mcpCredentialNamespace({ name: 'srv', pypiPackage: 'mcp-server-x' })).toBe('mcp-server-x')
  })

  it('prefers npm over pypi and falls back to the server name', () => {
    expect(mcpCredentialNamespace({ name: 'srv', npm_package: 'a', pypi_package: 'b' })).toBe('a')
    expect(mcpCredentialNamespace({ name: 'srv' })).toBe('srv')
  })

  it('builds the same ref from either shape', () => {
    expect(mcpCredentialRef({ name: 'srv', pypi_package: 'mcp-server-x' }, 'API_KEY'))
      .toBe(mcpCredentialRef({ name: 'srv', pypiPackage: 'mcp-server-x' }, 'API_KEY'))
  })
})
