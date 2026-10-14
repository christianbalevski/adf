import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-version-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-version-test', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import Ajv2020 from 'ajv/dist/2020'
import spec from '../docs/daemon/openapi.json'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { CLIENT_API_VERSION, parseStartedBy, takeLaunchEnv } from '../src/main/daemon/routes/meta-routes'
import { RuntimeService } from '../src/main/runtime/runtime-service'

const TOKEN = 't'.repeat(43)

function settingsStore(filePath: string, data: Record<string, unknown>) {
  return { filePath, get: (key: string) => data[key] }
}

function validateVersionInfo(body: unknown): string[] {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  ajv.addSchema(spec as object, 'spec')
  const validate = ajv.compile({ $ref: 'spec#/components/schemas/DaemonVersionInfo' })
  return validate(body) ? [] : (validate.errors ?? []).map(e => `${e.instancePath} ${e.message}`)
}

describe('GET /version', () => {
  it('identifies the daemon run', async () => {
    const settingsPath = join(tmpdir(), 'adf-version-test', 'adf-settings.json')
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
      version: '0.7.8',
      routes: { startedBy: 'studio' },
      settingsStore: settingsStore(settingsPath, { runtimeId: 'runtime-1' }),
      security: { token: TOKEN },
    })
    try {
      const res = await server.inject({ method: 'GET', url: '/version', headers: { authorization: `Bearer ${TOKEN}` } })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toEqual({
        version: '0.7.8',
        clientApiVersion: CLIENT_API_VERSION,
        settingsPath,
        dataDir: join(tmpdir(), 'adf-version-test'),
        runtimeId: 'runtime-1',
        pid: process.pid,
        startedBy: 'studio',
      })
      expect(validateVersionInfo(body)).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('needs the access token', async () => {
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { security: { token: TOKEN } })
    try {
      const res = await server.inject({ method: 'GET', url: '/version' })
      expect(res.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('defaults: never a null version, started by the CLI, no settings file', async () => {
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }))
    try {
      const body = (await server.inject({ method: 'GET', url: '/version' })).json()
      expect(typeof body.version).toBe('string')
      expect(body.version.length).toBeGreaterThan(0)
      expect(body).toMatchObject({ clientApiVersion: CLIENT_API_VERSION, settingsPath: null, dataDir: null, runtimeId: null, startedBy: 'cli' })
      expect(validateVersionInfo(body)).toEqual([])
    } finally {
      await server.close()
    }
  })
})

describe('parseStartedBy', () => {
  it('accepts studio and service; anything else is the CLI', () => {
    expect(parseStartedBy('studio')).toBe('studio')
    expect(parseStartedBy('service')).toBe('service')
    expect(parseStartedBy(undefined)).toBe('cli')
    expect(parseStartedBy('Studio')).toBe('cli')
  })
})

describe('takeLaunchEnv', () => {
  it('returns who launched the daemon and strips the launch-only variables', () => {
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', ADF_DAEMON_STARTED_BY: 'studio', PATH: '/usr/bin' }
    expect(takeLaunchEnv(env)).toBe('studio')
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
  it('defaults to the CLI', () => {
    expect(takeLaunchEnv({})).toBe('cli')
  })
})
