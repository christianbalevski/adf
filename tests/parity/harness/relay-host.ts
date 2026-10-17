import { createServer } from 'node:net'

/**
 * Where the harness's remote-mode Studio runs its OAuth callback relay: a
 * loopback address other than the daemon's 127.0.0.1, as on another
 * computer. 127.0.0.2 where the OS routes all of 127/8 to loopback (Windows,
 * Linux); macOS configures only 127.0.0.1 (EADDRNOTAVAIL), so ::1 there.
 */
export const RELAY_HOST: string = await (async () => {
  const s = createServer()
  try {
    await new Promise<void>((done, fail) => { s.once('error', fail); s.listen(0, '127.0.0.2', () => done()) })
    await new Promise<void>((done) => s.close(() => done()))
    return '127.0.0.2'
  } catch {
    return '::1'
  }
})()

/** RELAY_HOST as a URL host. */
export const RELAY_URL_HOST = RELAY_HOST.includes(':') ? `[${RELAY_HOST}]` : RELAY_HOST
