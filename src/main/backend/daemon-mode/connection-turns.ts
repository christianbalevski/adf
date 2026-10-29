import type { DaemonConnection } from './connection'

/** Desktop and browser chats use the same grace period for a lost event stream. */
export const TURN_DISCONNECT_GRACE_MS = 15_000

export function followConnectionTurns(
  connection: Pick<DaemonConnection, 'state' | 'onState'>,
  fail: () => void,
  recheck: () => void,
  log: Pick<Console, 'warn'> = console,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => { if (timer) clearTimeout(timer); timer = null }
  const off = connection.onState((state) => {
    if (state.state === 'failed') { clear(); fail() }
    if (state.state === 'disconnected' && !timer) {
      timer = setTimeout(() => {
        timer = null
        if (connection.state.state === 'disconnected') {
          log.warn(`[Backend] The ADF daemon has been away for ${TURN_DISCONNECT_GRACE_MS / 1000}s; ending the chats that wait for their turn`)
          fail()
        }
      }, TURN_DISCONNECT_GRACE_MS)
      timer.unref?.()
    }
    if (state.state === 'connected') { clear(); recheck() }
  })
  return () => { off(); clear() }
}
