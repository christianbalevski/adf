/** Durable, model-visible record of an owner command invocation. */
export const OWNER_COMMAND_MARKER = '[Owner command] '
export interface OwnerCommandHeader {
  v: 1
  id: string
  command: string
  lambda: string
  authorized: boolean
  status: 'ok' | 'error' | 'denied'
  duration_ms: number
}
export function formatOwnerCommandRow(header: OwnerCommandHeader, body: string): string {
  return `${OWNER_COMMAND_MARKER}${JSON.stringify(header)}\n${body}`
}
export function parseOwnerCommandRow(text: string): { header: OwnerCommandHeader; body: string } | null {
  if (!text.startsWith(OWNER_COMMAND_MARKER)) return null
  const newline = text.indexOf('\n')
  try {
    const header = JSON.parse(text.slice(OWNER_COMMAND_MARKER.length, newline < 0 ? undefined : newline))
    if (!header || header.v !== 1 || typeof header.id !== 'string' || typeof header.command !== 'string' || typeof header.lambda !== 'string' ||
      typeof header.authorized !== 'boolean' || typeof header.duration_ms !== 'number' || !Number.isFinite(header.duration_ms) || header.duration_ms < 0 ||
      !['ok', 'error', 'denied'].includes(header.status)) return null
    return { header, body: newline < 0 ? '' : text.slice(newline + 1) }
  } catch { return null }
}
export function isOwnerCommandRow(text: string): boolean { return parseOwnerCommandRow(text) !== null }
