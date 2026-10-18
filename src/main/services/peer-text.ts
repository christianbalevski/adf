/**
 * Text other computers send (mDNS TXT, `/remote/hello`, pairing replies) is
 * untrusted: bounded at intake, cleaned before it is stored, and never
 * printed raw to a terminal (docs/design/remote-access.md §5.1, discovery
 * review 3).
 */

import { cleanDisplayName, UNSAFE_DISPLAY_CHARS } from '../daemon/remote-access/config'

/** At most this many bytes of a hello body or of an announcement's TXT record are read. */
export const PEER_BODY_MAX_BYTES = 4_096
/** One TXT string (RFC 6763 §6.1: at most 255 bytes). */
export const TXT_VALUE_MAX_BYTES = 255

/** ESC/CSI/OSC/DCS sequences and their 8-bit forms: a terminal acts on them. */
const TERMINAL_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|\u001b[PX^_][^\u001b\u009c]*(?:\u001b\\|\u009c)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c]*(?:\u0007|\u009c)?|[\u0090\u0098\u009e\u009f][^\u009c]*\u009c?/g

/** Text without terminal sequences, control characters (newline kept), bidi overrides or invisible characters. */
export function printable(text: string): string {
  const unsafe = new RegExp(UNSAFE_DISPLAY_CHARS.source, 'gu')
  return text
    .replace(TERMINAL_SEQUENCES, '')
    .split('\n')
    .map((line) => line.replace(unsafe, ''))
    .join('\n')
}

/**
 * A name from another computer: sequences and unsafe characters dropped,
 * whitespace collapsed, cut to `max` characters, then cleanDisplayName.
 * Null when nothing printable is left.
 */
export function peerName(raw: unknown, max = 63): string | null {
  if (typeof raw !== 'string' || raw.length > PEER_BODY_MAX_BYTES) return null
  const text = printable(raw).replace(/\s+/g, ' ').trim()
  const cut = [...text].slice(0, max).join('').trim()
  return cleanDisplayName(cut, max)
}

/** A TXT record within bounds: each value at most 255 bytes, all of them at most 4 KB. */
export function txtWithinBounds(txt: Record<string, unknown>): boolean {
  let total = 0
  for (const [key, value] of Object.entries(txt)) {
    const bytes = Buffer.byteLength(key) + 1 + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : String(value).length)
    if (bytes > TXT_VALUE_MAX_BYTES) return false
    total += bytes + 1
    if (total > PEER_BODY_MAX_BYTES) return false
  }
  return true
}

/** The body of a response, or null when it is larger than `max` bytes (read no further). */
export async function readCapped(res: Response, max = PEER_BODY_MAX_BYTES): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks).toString('utf8')
}
