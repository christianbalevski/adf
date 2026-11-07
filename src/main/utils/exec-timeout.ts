/**
 * Whether execFile's callback error means the child was killed by the call's
 * own `timeout` (the error then carries `killed: true`). An output overflow is
 * never a timeout: Node reports it as ERR_CHILD_PROCESS_STDIO_MAXBUFFER and,
 * as of Node 22/24, does not set `killed` on that error — the code check keeps
 * the rule explicit rather than resting on that detail.
 */
export function killedByTimeout(error: unknown): boolean {
  if (error == null) return false
  const e = error as { killed?: boolean; code?: unknown }
  return e.killed === true && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
}
