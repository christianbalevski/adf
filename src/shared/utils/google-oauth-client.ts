/**
 * The built-in Google OAuth client of the Google catalog servers (Gmail,
 * Google Calendar): one client, one row per server.
 *
 * Release builds can embed a Google "Desktop app" OAuth client so Connect
 * works without the user creating their own Cloud project. The client JSON
 * comes from the ADF_GMAIL_OAUTH_CLIENT_JSON environment variable at build
 * time (electron.vite.config.ts defines it into the Studio main and daemon
 * bundles) and is never committed; the variable keeps its first name. A
 * Desktop client is not confidential: anyone can extract it from the
 * installed app. It identifies the app to Google, it grants nothing; the
 * user's tokens are still created by each server's own sign-in and stay in
 * that server's token file.
 *
 * Pure (no Node or Electron imports): the build config imports it too.
 */

/**
 * A catalog server the built-in client is for: its package, the declared
 * credential file the client fills, and, when the server finds that file
 * only through an environment variable, that variable (mcp-server-home.ts
 * sets it to `path`). Gmail needs none: its default is `path` under HOME.
 */
export interface BuiltInClientFile {
  npmPackage: string
  path: string
  env?: string
}

export const BUILT_IN_CLIENT_FILES: readonly BuiltInClientFile[] = [
  { npmPackage: '@gongrzhe/server-gmail-autoauth-mcp', path: '~/.gmail-mcp/gcp-oauth.keys.json' },
  { npmPackage: '@cocal/google-calendar-mcp', path: '~/.config/google-calendar-mcp/gcp-oauth.keys.json', env: 'GOOGLE_OAUTH_CREDENTIALS' },
]

/** Build-time environment variable carrying the client JSON. */
export const GMAIL_OAUTH_CLIENT_ENV = 'ADF_GMAIL_OAUTH_CLIENT_JSON'

/** Token-shaped keys a client file must never carry. */
const TOKEN_KEYS = ['access_token', 'refresh_token', 'id_token', 'token']

/**
 * Validate the client JSON a build was given and return its normalized form
 * (`{"installed":{...}}`), or undefined when none was given (unset or blank:
 * builds without the secret keep the manual file flow).
 *
 * Throws on anything that is not a Desktop OAuth client. Error messages never
 * include the input.
 */
export function parseGmailOAuthClientJson(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const fail = (why: string): never => {
    throw new Error(`${GMAIL_OAUTH_CLIENT_ENV} is not a Google Desktop OAuth client JSON: ${why}.`)
  }
  let doc: unknown
  try { doc = JSON.parse(raw) } catch { return fail('it is not valid JSON') }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fail('expected a JSON object')
  const installed = (doc as Record<string, unknown>).installed
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    return fail((doc as Record<string, unknown>).web ? 'it is a Web application client; create a Desktop app client' : 'it has no "installed" client')
  }
  const client = installed as Record<string, unknown>
  if (typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com')) {
    return fail('installed.client_id is missing or not a Google client ID')
  }
  if (typeof client.client_secret !== 'string' || client.client_secret === '') {
    return fail('installed.client_secret is missing')
  }
  if (TOKEN_KEYS.some((k) => k in client || k in (doc as Record<string, unknown>))) {
    return fail('it carries tokens; embed the client only')
  }
  return JSON.stringify({ installed: client })
}
