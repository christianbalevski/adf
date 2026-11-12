import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PodmanService } from '../../../src/main/services/podman.service'

const SWIFTSHADER_FLAG = '--enable-unsafe-swiftshader'
const ROTATION = 'mv -f /tmp/adf-browser/chromium.log /tmp/adf-browser/chromium.log.1 2>/dev/null'

/** The script Studio installs: taken from the real install exec, where it
 *  travels as a base64 blob. */
async function installedScript(): Promise<string> {
  const service = new PodmanService()
  const exec0 = vi.fn<(bin: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>>(async () => ({ code: 0, stdout: '', stderr: '' }))
  const internals = service as unknown as Record<string, unknown>
  internals.exec0 = exec0
  internals.getBrowserRuntimeCompatibility = vi.fn().mockResolvedValue({})
  internals.getBrowserHostIdentity = vi.fn().mockReturnValue({ timezone: 'UTC', locale: 'en-US' })
  await (internals.ensureManagedBrowser as (bin: string, name: string) => Promise<void>).call(service, '/usr/bin/podman', 'adf-agent-12345678')
  const install = exec0.mock.calls.map(([, args]) => String(args[4] ?? '')).find((cmd) => cmd.includes("> '/usr/local/bin/adf-browser.tmp'"))
  const blob = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(install ?? '')?.[1]
  if (!blob) throw new Error('adf-browser install command not found')
  return Buffer.from(blob, 'base64').toString('utf8')
}

describe('adf-browser generated script', () => {
  it('passes the flag on the exec line and rotates only in launch-detached', async () => {
    const script = await installedScript()
    const launchBody = /^launch\(\) \{\n([\s\S]*?)^\}/m.exec(script)?.[1] ?? ''
    const execLine = launchBody.split('\n').find((line) => line.trim().startsWith('exec ')) ?? ''
    expect(execLine).toContain(SWIFTSHADER_FLAG)
    expect(execLine).toContain('>>/tmp/adf-browser/chromium.log')
    expect(launchBody).not.toContain('chromium.log.1')
    expect(script.split('\n').find((line) => line.trim().startsWith('launch-detached)'))).toContain(ROTATION)
  })
})

// Runs the generated script for real, with its absolute paths moved into a temp
// dir and chromium, wget and xdotool faked on PATH. Needs a POSIX sh.
describe.skipIf(process.platform === 'win32')('adf-browser run under sh', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  async function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'adf-webgl-'))
    root = dir
    const bin = join(dir, 'bin')
    const logDir = join(dir, 'tmp')
    mkdirSync(bin)
    mkdirSync(logDir)
    const argsFile = join(dir, 'args')
    const fake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    fake('chromium', `printf '%s\\n' "$@" > '${argsFile}'\necho fresh-output`)
    fake('wget', 'exit 0') // CDP answers: a browser is already running
    fake('xdotool', 'exit 0')
    fake('setsid', 'shift; exec "$@"') // macOS has no setsid; drop -f and run the detached command

    const script = (await installedScript())
      .replaceAll('/tmp/adf-browser', logDir)
      .replaceAll('/var/lib/adf/browser-profile', join(dir, 'profile'))
      .replaceAll("'/usr/bin/chromium'", `'${join(bin, 'chromium')}'`)
    expect(script).not.toContain('/usr/bin/chromium')
    const scriptPath = join(dir, 'adf-browser')
    writeFileSync(scriptPath, script, { mode: 0o755 })

    return {
      fake,
      argsFile,
      log: join(logDir, 'chromium.log'),
      previous: join(logDir, 'chromium.log.1'),
      args: () => readFileSync(argsFile, 'utf8').split('\n'),
      run: (...args: string[]) => spawnSync('sh', [scriptPath, ...args], {
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
    }
  }

  it('moves the old log aside, replacing the older one, and launches with the flag', async () => {
    const box = await sandbox()
    writeFileSync(box.log, 'previous-run\n')
    writeFileSync(box.previous, 'older-run\n')

    const result = box.run('launch-detached')

    expect(result.status).toBe(0)
    expect(readFileSync(box.previous, 'utf8')).toBe('previous-run\n')
    expect(readFileSync(box.log, 'utf8')).toBe('fresh-output\n')
    expect(box.args()).toContain(SWIFTSHADER_FLAG)
  })

  it('launches quietly when there is no log to rotate yet', async () => {
    const box = await sandbox()

    const result = box.run('launch-detached')

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(box.previous)).toBe(false)
    expect(readFileSync(box.log, 'utf8')).toBe('fresh-output\n')
  })

  it('start with no browser running goes through launch-detached and rotates', async () => {
    const box = await sandbox()
    box.fake('wget', `[ -f '${box.argsFile}' ]`) // CDP answers once the browser has launched
    writeFileSync(box.log, 'previous-run\n')

    const result = box.run('start', 'https://example.test/')

    expect(result.status).toBe(0)
    expect(readFileSync(box.previous, 'utf8')).toBe('previous-run\n')
    expect(readFileSync(box.log, 'utf8')).toBe('fresh-output\n')
    expect(box.args()).toContain('https://example.test/')
    expect(box.args()).toContain(SWIFTSHADER_FLAG)
  })

  // The tests above fake setsid (macOS has none); this one runs the real detach.
  it.runIf(process.platform === 'linux')('start detaches the browser through the real setsid', async () => {
    const box = await sandbox()
    rmSync(join(box.argsFile, '..', 'bin', 'setsid'))
    box.fake('wget', `[ -s '${box.argsFile}' ]`) // CDP answers once the browser has launched

    const result = box.run('start', 'https://example.test/')

    expect(result.status).toBe(0)
    expect(box.args()).toContain('https://example.test/')
    expect(box.args()).toContain(SWIFTSHADER_FLAG)
  })

  it('leaves the live log alone when handing a URL to a running browser', async () => {
    const box = await sandbox()
    writeFileSync(box.log, 'live-browser\n')

    const result = box.run('start', 'https://example.test/')

    expect(result.status).toBe(0)
    expect(box.args()).toContain('https://example.test/') // the hand-off really ran launch()
    expect(existsSync(box.previous)).toBe(false)
    expect(readFileSync(box.log, 'utf8')).toBe('live-browser\nfresh-output\n')
  })
})
