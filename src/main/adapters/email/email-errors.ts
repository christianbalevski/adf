import { withSetupGuide } from '../shared/error-hints'

/**
 * Providers that reject the regular account password over IMAP/SMTP and
 * require an app-specific password instead (which in turn requires
 * two-factor authentication to be enabled on the account first).
 * Keyed by email domain, value is the display name used in error hints.
 */
const APP_PASSWORD_PROVIDERS: Record<string, string> = {
  'gmail.com': 'Gmail',
  'googlemail.com': 'Gmail',
  'icloud.com': 'iCloud Mail',
  'me.com': 'iCloud Mail',
  'mac.com': 'iCloud Mail',
  'yahoo.com': 'Yahoo Mail',
  'fastmail.com': 'Fastmail',
  'fastmail.fm': 'Fastmail'
}

/** Display name of the app-password provider for an address, or null. */
export function appPasswordProviderFor(address: string | undefined): string | null {
  const domain = address?.split('@')[1]?.toLowerCase()
  return (domain && APP_PASSWORD_PROVIDERS[domain]) || null
}

/** Union of the error fields nodemailer and imapflow attach to their errors. */
interface MailErrorShape {
  message?: string
  /** Node socket / nodemailer error code (EAUTH, ECONNECTION, ETIMEDOUT, ...) */
  code?: string
  /** nodemailer: raw SMTP server response line */
  response?: string
  /** imapflow: human-readable server response text */
  responseText?: string
  /** nodemailer: numeric SMTP status (535, 550, 552, ...) */
  responseCode?: number
  /** imapflow: set when the server rejected the login */
  authenticationFailed?: boolean
}

/**
 * Flatten an IMAP/SMTP error into a compact detail string, preserving the
 * server response and error code — those carry the provider-specific facts
 * (e.g. Gmail's "Application-specific password required").
 */
export function emailErrorDetail(err: unknown): string {
  const e = (err ?? {}) as MailErrorShape
  const parts = [
    e.message,
    e.responseText && `Server: ${e.responseText}`,
    e.response && !e.responseText && `Response: ${e.response}`,
    e.code && `Code: ${e.code}`
  ].filter(Boolean)
  return parts.join(' — ') || String(err)
}

export interface EmailErrorContext {
  /** Which leg of the connection failed */
  transport: 'IMAP' | 'SMTP'
  /** The account's email address (drives app-password provider detection) */
  address?: string
  /** Host/port the adapter was talking to when the error occurred */
  host?: string
  port?: number
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  // nodemailer-specific connection/socket failure codes
  'ECONNECTION', 'ESOCKET', 'ETIMEOUT'
])

const CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
])

const CONFIG_HINT =
  'Server settings are auto-detected from the email domain ' +
  '(falling back to imap.{domain}:993 / smtp.{domain}:465 for unknown providers) ' +
  'and may not match this provider — set the real servers in the channel config ' +
  '("imap": {"host", "port"} and "smtp": {"host", "port"})'

/**
 * Map an IMAP/SMTP failure to an actionable message. These strings flow
 * verbatim into the agent's tool result — the agent reads them to walk the
 * user through a fix, so each recognized failure states what happened, the
 * likely cause, the concrete fix, and ends with the setup-guide link
 * (which carries the per-provider app-password pages).
 */
export function describeEmailError(err: unknown, ctx: EmailErrorContext): string {
  const e = (err ?? {}) as MailErrorShape
  const detail = emailErrorDetail(err)
  const haystack = [e.message, e.response, e.responseText, e.code]
    .filter(Boolean)
    .join(' ')
  const where = ctx.host
    ? `${ctx.host}${ctx.port ? `:${ctx.port}` : ''}`
    : `the ${ctx.transport} server`

  // --- Authentication rejected ---------------------------------------------
  const isAuth =
    e.code === 'EAUTH' ||
    e.authenticationFailed === true ||
    e.responseCode === 535 ||
    /\b535\b|authenticationfailed|invalid credentials|username and password not accepted|application-specific password|authentication failed|login failed/i.test(haystack)
  if (isAuth) {
    const who = ctx.address ? ` for ${ctx.address}` : ''
    const provider = appPasswordProviderFor(ctx.address)
    const fix = provider
      ? `${provider} requires an app-specific password — the regular account password will NOT work here. ` +
        'Enable two-factor authentication on the account first, then generate an app password ' +
        'and set it as the EMAIL_PASSWORD credential (EMAIL_USERNAME must be the full email address). ' +
        'Restart the adapter after updating the credentials.'
      : 'Check the EMAIL_USERNAME (usually the full email address) and EMAIL_PASSWORD credentials — ' +
        'many providers require an app-specific password instead of the account password, ' +
        'and some need IMAP/SMTP access explicitly enabled in the account settings. ' +
        'Restart the adapter after updating the credentials.'
    return withSetupGuide(
      'email',
      `${ctx.transport} authentication failed${who}: the server rejected the login (${detail}). ${fix}`
    )
  }

  // --- Message too large ----------------------------------------------------
  if (e.responseCode === 552 || /\b552\b|message size exceeds|exceeds .{0,30}size limit|too large|too big/i.test(haystack)) {
    return withSetupGuide(
      'email',
      `The mail server rejected the message as too large (${detail}). ` +
      "The body plus attachments exceed the provider's message size limit (commonly ~25MB) — " +
      'remove or shrink the attachments, or share large files via a link instead, then resend.'
    )
  }

  // --- Recipient/sender rejected --------------------------------------------
  if (
    (e.responseCode != null && [550, 553, 554].includes(e.responseCode)) ||
    /\b55[034]\b|mailbox unavailable|user unknown|no such user|relay(ing)? (denied|not allowed|not permitted)|(sender|recipient) address rejected/i.test(haystack)
  ) {
    const from = ctx.address ? ` (${ctx.address})` : ''
    return withSetupGuide(
      'email',
      `The mail server refused to deliver the message (${detail}). ` +
      'Double-check that the recipient address is a valid, existing email address. ' +
      `If it is correct, the provider may be rejecting this sender — confirm EMAIL_USERNAME matches the from address${from} ` +
      'and that the account is allowed to send mail through this SMTP server.'
    )
  }

  // --- TLS certificate problems ---------------------------------------------
  if ((e.code && CERT_CODES.has(e.code)) || /certificate|self[- ]signed|altname/i.test(haystack)) {
    return withSetupGuide(
      'email',
      `TLS certificate verification failed when connecting to ${where} (${detail}). ` +
      "This usually means the hostname does not match the provider's certificate. " +
      `${CONFIG_HINT}, then restart the adapter.`
    )
  }

  // --- Host unreachable ------------------------------------------------------
  if (
    (e.code && CONNECTION_CODES.has(e.code)) ||
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection (refused|timed out|closed)|connect timeout|greeting never received/i.test(haystack)
  ) {
    return withSetupGuide(
      'email',
      `Could not reach the ${ctx.transport} server at ${where} (${detail}). ` +
      'The host or port is wrong or unreachable, or a firewall is blocking the connection. ' +
      `${CONFIG_HINT}, verify network access, then restart the adapter.`
    )
  }

  // Unrecognized — pass the raw detail through (server response included).
  return detail
}
