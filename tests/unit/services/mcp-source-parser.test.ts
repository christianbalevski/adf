import { describe, it, expect } from 'vitest'
import { parseSource } from '../../../src/main/services/mcp-spawn-utils'

describe('parseSource', () => {
  it('parses uvx source with version', () => {
    const result = parseSource('uvx:browser-use-mcp-server@0.3.0')
    expect(result).toEqual({ runtime: 'uvx', package: 'browser-use-mcp-server', version: '0.3.0' })
  })

  it('parses uvx source without version', () => {
    const result = parseSource('uvx:some-mcp-server')
    expect(result).toEqual({ runtime: 'uvx', package: 'some-mcp-server', version: undefined })
  })

  it('parses npm source with scoped package', () => {
    const result = parseSource('npm:@modelcontextprotocol/server-github')
    expect(result).toEqual({ runtime: 'npm', package: '@modelcontextprotocol/server-github', version: undefined })
  })

  it('parses npm source with scoped package and version', () => {
    const result = parseSource('npm:@scope/pkg@1.2.3')
    expect(result).toEqual({ runtime: 'npm', package: '@scope/pkg', version: '1.2.3' })
  })

  it('parses npm source with unscoped package', () => {
    const result = parseSource('npm:mcp-server-fetch')
    expect(result).toEqual({ runtime: 'npm', package: 'mcp-server-fetch', version: undefined })
  })

  it('parses npm source with unscoped package and version', () => {
    const result = parseSource('npm:mcp-server-fetch@1.0.0')
    expect(result).toEqual({ runtime: 'npm', package: 'mcp-server-fetch', version: '1.0.0' })
  })

  it('parses pip source', () => {
    const result = parseSource('pip:some-server')
    expect(result).toEqual({ runtime: 'pip', package: 'some-server', version: undefined })
  })

  it('parses pip source with version', () => {
    const result = parseSource('pip:some-server@2.0.0')
    expect(result).toEqual({ runtime: 'pip', package: 'some-server', version: '2.0.0' })
  })

  it('parses npx source', () => {
    const result = parseSource('npx:some-package')
    expect(result).toEqual({ runtime: 'npx', package: 'some-package', version: undefined })
  })

  it('returns custom for "custom" string', () => {
    const result = parseSource('custom')
    expect(result).toEqual({ runtime: 'custom' })
  })

  it('returns custom for undefined', () => {
    const result = parseSource(undefined)
    expect(result).toEqual({ runtime: 'custom' })
  })

  it('returns custom for empty string', () => {
    const result = parseSource('')
    expect(result).toEqual({ runtime: 'custom' })
  })

  it('returns custom for unknown prefix', () => {
    const result = parseSource('docker:some-image')
    expect(result).toEqual({ runtime: 'custom' })
  })

  it('returns custom for string without colon', () => {
    const result = parseSource('justAString')
    expect(result).toEqual({ runtime: 'custom' })
  })
})
