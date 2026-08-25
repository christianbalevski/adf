import { describe, expect, it } from 'vitest'
import { MCP_REGISTRY } from '../../../src/shared/constants/mcp-registry'
import { BRAND_ICON_KEYS } from '../../../src/renderer/components/mcp/BrandIcon'

/**
 * §2 name-squat blocklist (docs/design/mcp-registry-expansion.md): packages
 * that squat well-known project names but belong to unrelated third parties.
 * The registry must never map an entry to any of these.
 */
const SQUATTED_PYPI = ['mcp-gmail', 'telegram-mcp', 'mcp-server-milvus']
const SQUATTED_NPM = ['mcp-filesystem-server', 'github-mcp-server']

/** A bare `{placeholder}` arg the user must fill in before install. */
const BARE_PLACEHOLDER_RE = /^\{[a-z0-9-]+\}$/

describe('curated registry data integrity', () => {
  it('entry names are unique', () => {
    const names = MCP_REGISTRY.map((e) => e.name)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dupes).toEqual([])
  })

  it('npm packages, PyPI packages, and URLs are each unique across entries', () => {
    for (const key of ['npmPackage', 'pypiPackage', 'url'] as const) {
      const values = MCP_REGISTRY.map((e) => e[key]).filter((v): v is string => !!v)
      const dupes = values.filter((v, i) => values.indexOf(v) !== i)
      expect(dupes, `duplicate ${key} values`).toEqual([])
    }
  })

  it('every entry has exactly one of npmPackage / pypiPackage / url', () => {
    const offenders = MCP_REGISTRY
      .filter((e) => [e.npmPackage, e.pypiPackage, e.url].filter(Boolean).length !== 1)
      .map((e) => e.name)
    expect(offenders).toEqual([])
  })

  it("runtime 'python' exactly when the entry has a pypiPackage", () => {
    for (const entry of MCP_REGISTRY) {
      if (entry.pypiPackage) {
        expect(entry.runtime, `entry ${entry.name} has pypiPackage but runtime !== 'python'`).toBe('python')
      } else {
        expect(entry.runtime, `entry ${entry.name} declares runtime 'python' without a pypiPackage`).not.toBe('python')
      }
    }
  })

  it('headerEnv / bearerTokenEnvVar appear only on url (remote) entries', () => {
    const offenders = MCP_REGISTRY
      .filter((e) => !e.url && (e.headerEnv || e.bearerTokenEnvVar))
      .map((e) => e.name)
    expect(offenders).toEqual([])
  })

  it('auth / authArgs / credentialFiles never appear on url (remote) entries', () => {
    const offenders = MCP_REGISTRY
      .filter((e) => e.url && (e.auth || e.authArgs || e.credentialFiles))
      .map((e) => e.name)
    expect(offenders).toEqual([])
  })

  it('oauth / oauthClientId / oauthScopes appear only on url (remote) entries', () => {
    const offenders = MCP_REGISTRY
      .filter((e) => !e.url && (e.oauth || e.oauthClientId || e.oauthScopes))
      .map((e) => e.name)
    expect(offenders).toEqual([])
  })

  it('dual-mode entries carry both oauth and a bearerTokenEnvVar fallback', () => {
    const dualMode = ['github', 'linear', 'atlassian-cloud', 'cloudflare-bindings', 'cloudflare-observability', 'neon', 'huggingface']
    for (const name of dualMode) {
      const entry = MCP_REGISTRY.find((e) => e.name === name)
      expect(entry, `missing dual-mode entry ${name}`).toBeDefined()
      expect(entry!.url, `${name} must be a remote entry`).toBeTruthy()
      expect(entry!.oauth, `${name} must declare oauth`).toBe(true)
      expect(entry!.bearerTokenEnvVar, `${name} must keep its paste-token fallback`).toBeTruthy()
    }
  })

  it('OAuth-only remote entries carry oauth with no bearer/header fallback', () => {
    const oauthOnly = ['notion-remote', 'sentry-remote', 'supabase-remote', 'todoist-remote', 'clickup', 'readwise']
    for (const name of oauthOnly) {
      const entry = MCP_REGISTRY.find((e) => e.name === name)
      expect(entry, `missing OAuth-only entry ${name}`).toBeDefined()
      expect(entry!.url, `${name} must be a remote entry`).toBeTruthy()
      expect(entry!.oauth, `${name} must declare oauth`).toBe(true)
      expect(entry!.bearerTokenEnvVar, `${name} should not carry a bearer fallback`).toBeUndefined()
      expect(entry!.headerEnv, `${name} should not carry header credentials`).toBeUndefined()
    }
  })

  it('every iconKey resolves to a known brand icon', () => {
    const known = new Set(BRAND_ICON_KEYS)
    const dangling = MCP_REGISTRY
      .filter((e) => e.iconKey && !known.has(e.iconKey))
      .map((e) => `${e.name} → ${e.iconKey}`)
    expect(dangling).toEqual([])
  })

  it('bare placeholder args match the {kebab-case} placeholder grammar', () => {
    for (const entry of MCP_REGISTRY) {
      for (const arg of entry.args ?? []) {
        if (arg.includes('{') || arg.includes('}')) {
          expect(arg, `entry ${entry.name}: malformed placeholder arg "${arg}"`).toMatch(BARE_PLACEHOLDER_RE)
        }
      }
    }
  })

  it('no entry maps a name-squatted package from the §2 blocklist', () => {
    const offenders = MCP_REGISTRY
      .filter((e) =>
        (e.pypiPackage && SQUATTED_PYPI.includes(e.pypiPackage)) ||
        (e.npmPackage && SQUATTED_NPM.includes(e.npmPackage)))
      .map((e) => e.name)
    expect(offenders).toEqual([])
  })
})
