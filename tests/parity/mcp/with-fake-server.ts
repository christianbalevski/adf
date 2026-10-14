import type { ParityBackend } from '../harness/backend'
import { completeFakeAuthorization, type FakeMcpServer } from './fake-mcp-server'

/**
 * A backend the fake MCP server (fake-mcp-server.ts) is reachable from: the
 * run may connect to its port (the daemon child reads its fence ports at
 * spawn), an authorization page of it that Studio opens is signed in to, as
 * a browser would (completeFakeAuthorization), and its port is normalized
 * as FAKE_MCP_PORT.
 */
export function withFakeServer(fake: () => FakeMcpServer): (backend: ParityBackend) => ParityBackend {
  return (backend) => ({
    name: backend.name,
    async boot(env, electron) {
      const server = fake()
      env.allowPort(server.port)
      const shell = electron.module.shell as { openExternal(url: string): Promise<void> }
      const open = shell.openExternal.bind(shell)
      shell.openExternal = async (url: string) => {
        await open(url)
        void completeFakeAuthorization(url, server.port, (p) => env.allowPort(p))
      }
      const booted = await backend.boot(env, electron)
      const own = booted.normalization?.bind(booted)
      return Object.assign(booted, {
        normalization: () => {
          const extra = own?.() ?? {}
          return { ...extra, ports: [...(extra.ports ?? []), { value: String(server.port), name: 'FAKE_MCP_PORT' }] }
        },
      })
    },
  })
}
