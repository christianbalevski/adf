import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PATH_END_MARKER,
  PATH_START_MARKER,
  fallbackPath,
  isPlausiblePath,
  parseLoginShellPath,
  resolveLoginShellPath,
  type LoginShellExec,
} from '../../../src/main/utils/login-shell-path'

const marked = (envBlock: string, before = '', after = ''): string =>
  `${before}${PATH_START_MARKER}\n${envBlock}\n${PATH_END_MARKER}\n${after}`

describe('parseLoginShellPath', () => {
  it('reads PATH from the marked env block', () => {
    const out = marked('HOME=/Users/me\nPATH=/opt/homebrew/bin:/usr/bin:/bin\nSHELL=/bin/zsh')
    expect(parseLoginShellPath(out)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('ignores banner text that rc files print around the block', () => {
    const out = marked(
      'PATH=/usr/local/bin:/usr/bin',
      'Welcome to your shell!\nPATH=/bogus/from/motd\n',
      'conda: base environment activated\n',
    )
    expect(parseLoginShellPath(out)).toBe('/usr/local/bin:/usr/bin')
  })

  it('handles CRLF line endings', () => {
    const out = `${PATH_START_MARKER}\r\nPATH=/usr/bin:/bin\r\n${PATH_END_MARKER}\r\n`
    expect(parseLoginShellPath(out)).toBe('/usr/bin:/bin')
  })

  it('returns null without markers or a PATH line', () => {
    expect(parseLoginShellPath('/usr/bin:/bin')).toBeNull()
    expect(parseLoginShellPath(`${PATH_START_MARKER}\nPATH=/usr/bin`)).toBeNull()
    expect(parseLoginShellPath(marked('HOME=/Users/me'))).toBeNull()
  })

  it('rejects the space-joined list fish prints for `echo $PATH`', () => {
    expect(parseLoginShellPath(marked('PATH=/opt/homebrew/bin /usr/bin /bin'))).toBeNull()
  })

  it('reads the real block when xtrace echoes the command line first', () => {
    const xtrace = `+ echo ${PATH_START_MARKER}; /usr/bin/env; echo ${PATH_END_MARKER}\n`
    expect(parseLoginShellPath(xtrace + marked('PATH=/usr/local/bin:/usr/bin'))).toBe('/usr/local/bin:/usr/bin')
  })

  it('takes the last plausible PATH= line in the block', () => {
    const block = 'NOTES=first line\nPATH=not a path\nPATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/me'
    expect(parseLoginShellPath(marked(block))).toBe('/opt/homebrew/bin:/usr/bin')
  })
})

describe('isPlausiblePath', () => {
  it('requires at least one absolute entry', () => {
    expect(isPlausiblePath('/usr/bin')).toBe(true)
    expect(isPlausiblePath('bin:sbin')).toBe(false)
    expect(isPlausiblePath('')).toBe(false)
    expect(isPlausiblePath(':::')).toBe(false)
  })
})

describe('fallbackPath', () => {
  it('appends the platform package-manager dirs without duplicating them', () => {
    expect(fallbackPath('/usr/bin:/bin:/usr/local/bin', 'darwin', '/Users/me')).toBe(
      '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:/Users/me/.local/bin',
    )
    expect(fallbackPath('/usr/bin', 'win32', '/Users/me')).toBe('/usr/bin')
  })

  it('keeps inherited entries first so system binaries are not shadowed', () => {
    expect(fallbackPath('/usr/bin:/bin', 'linux', '/home/me').split(':').slice(0, 2)).toEqual(['/usr/bin', '/bin'])
  })
})

describe('resolveLoginShellPath', () => {
  const base = { shell: '/bin/zsh', currentPath: '/usr/bin:/bin', platform: 'darwin' as const }

  it('uses the login-shell PATH when the output parses', () => {
    const exec: LoginShellExec = () => marked('PATH=/opt/homebrew/bin:/usr/bin')
    expect(resolveLoginShellPath({ ...base, exec })).toEqual({
      source: 'login-shell',
      path: '/opt/homebrew/bin:/usr/bin',
    })
  })

  it('passes separate -i -l -c flags and a timeout', () => {
    const calls: Array<{ shell: string; args: string[]; timeoutMs: number }> = []
    const exec: LoginShellExec = (shell, args, timeoutMs) => {
      calls.push({ shell, args, timeoutMs })
      return marked('PATH=/usr/bin')
    }
    resolveLoginShellPath({ ...base, exec, timeoutMs: 1234 })
    expect(calls[0].shell).toBe('/bin/zsh')
    expect(calls[0].args.slice(0, 3)).toEqual(['-i', '-l', '-c'])
    expect(calls[0].timeoutMs).toBe(1234)
  })

  it('falls back when the shell fails or times out', () => {
    const exec: LoginShellExec = () => {
      throw new Error('spawnSync /bin/zsh ETIMEDOUT')
    }
    const result = resolveLoginShellPath({ ...base, exec, home: '/Users/me' })
    expect(result.source).toBe('fallback')
    expect(result.path).toBe('/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/Users/me/.local/bin')
    if (result.source === 'fallback') expect(result.reason).toContain('ETIMEDOUT')
  })

  it('uses the output of a shell that exits non-zero or times out after printing', () => {
    // bash/zsh exit with the -c command's status even when an rc file fails,
    // but a hanging logout hook (timeout) or an error-propagating shell can
    // still end in an exec error after env has printed.
    const exec: LoginShellExec = () => {
      throw Object.assign(new Error('Command failed: /bin/zsh -i -l -c ...'), {
        status: 1,
        stdout: marked('PATH=/Users/me/.nvm/versions/node/v22/bin:/usr/bin'),
      })
    }
    expect(resolveLoginShellPath({ ...base, exec })).toEqual({
      source: 'login-shell',
      path: '/Users/me/.nvm/versions/node/v22/bin:/usr/bin',
    })
  })

  it('falls back when the output has no usable PATH', () => {
    const exec: LoginShellExec = () => '/opt/homebrew/bin /usr/bin'
    expect(resolveLoginShellPath({ ...base, exec }).source).toBe('fallback')
  })
})

// Exercise the real script against the shells installed on this machine.
const realShells = ['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish', '/usr/bin/fish']
  .filter((shell) => process.platform !== 'win32' && existsSync(shell))

describe.skipIf(realShells.length === 0)('resolveLoginShellPath against real shells', () => {
  it.each(realShells)('%s yields a plausible PATH', (shell) => {
    const result = resolveLoginShellPath({ shell, currentPath: '/usr/bin:/bin', platform: process.platform, timeoutMs: 10_000 })
    expect(result.source, result.source === 'fallback' ? result.reason : '').toBe('login-shell')
    expect(isPlausiblePath(result.path)).toBe(true)
  })
})
