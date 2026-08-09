import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdapterContext,
  AdapterInstanceConfig
} from '../../../src/shared/types/channel-adapter.types'

const GUIDE_URL =
  'Setup guide: https://github.com/christianbalevski/adf/blob/main/docs/guides/messaging.md#email-adapter'

// vi.mock factories hoist — keep all mutable mock state on globalThis so it
// doesn't TDZ when the factory runs ahead of module init.
declare global {
  // eslint-disable-next-line no-var
  var __emailErrMocks: {
    /** Forces the next ImapFlow .connect() call to reject with this error */
    nextConnectError: Error | null
    /** Behavior of transporter.sendMail — swap per test */
    sendMailImpl: (() => Promise<{ messageId: string }>) | null
    /** Behavior of transporter.verify */
    verifyImpl: (() => Promise<boolean>) | null
  }
}

vi.mock('imapflow', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events')

  class MockImapFlow extends NodeEventEmitter {
    public close = vi.fn()
    public connect = vi.fn(async () => {
      if (globalThis.__emailErrMocks.nextConnectError) {
        const err = globalThis.__emailErrMocks.nextConnectError
        globalThis.__emailErrMocks.nextConnectError = null
        throw err
      }
    })
    public getMailboxLock = vi.fn(async () => ({ release: () => {} }))
    public fetch = vi.fn(async function* () { /* yield nothing */ })
    public messageFlagsAdd = vi.fn()
  }

  return { ImapFlow: MockImapFlow }
})

vi.mock('nodemailer', () => {
  return {
    default: {
      createTransport: () => ({
        verify: vi.fn(async () => globalThis.__emailErrMocks.verifyImpl?.() ?? true),
        sendMail: vi.fn(async () => {
          if (globalThis.__emailErrMocks.sendMailImpl) {
            return globalThis.__emailErrMocks.sendMailImpl()
          }
          return { messageId: 'mock@id' }
        }),
        close: vi.fn()
      })
    }
  }
})

// Import AFTER vi.mock so the factories win.
import { EmailAdapter } from '../../../src/main/adapters/email/email-adapter'
import { describeEmailError } from '../../../src/main/adapters/email/email-errors'

/** Build an error carrying nodemailer/imapflow-style metadata. */
function mailError(
  message: string,
  extra: Partial<{
    code: string
    response: string
    responseCode: number
    responseText: string
    authenticationFailed: boolean
  }> = {}
): Error {
  return Object.assign(new Error(message), extra)
}

function makeCtx(username = 'user@example.com'): AdapterContext & { logs: Array<{ level: string; msg: string }> } {
  const logs: Array<{ level: string; msg: string }> = []
  const credentials: Record<string, string | null> = {
    EMAIL_USERNAME: username,
    EMAIL_PASSWORD: 'hunter2'
  }
  const config: AdapterInstanceConfig = {
    enabled: true,
    config: {
      // Polling mode so we don't kick off the long-running IDLE loop
      idle: false,
      poll_interval: 1_000_000
    }
  }
  return {
    ingest: vi.fn(),
    writeAttachment: vi.fn(),
    getConfig: () => config,
    getCredential: (k: string) => credentials[k] ?? null,
    log: vi.fn((level: 'info' | 'warn' | 'error', msg: string) => { logs.push({ level, msg }) }),
    logs
  } as AdapterContext & { logs: Array<{ level: string; msg: string }> }
}

beforeEach(() => {
  globalThis.__emailErrMocks = {
    nextConnectError: null,
    sendMailImpl: null,
    verifyImpl: null
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('describeEmailError', () => {
  it('maps SMTP EAUTH for a gmail.com address to an app-specific-password hint with the setup guide', () => {
    const err = mailError('Invalid login: 535-5.7.8 Username and Password not accepted', {
      code: 'EAUTH',
      responseCode: 535,
      response: '535-5.7.8 Username and Password not accepted'
    })
    const msg = describeEmailError(err, {
      transport: 'SMTP',
      address: 'agent@gmail.com',
      host: 'smtp.gmail.com',
      port: 465
    })

    expect(msg).toContain('SMTP authentication failed for agent@gmail.com')
    // Explicitly names the provider and demands an app password, not the account password
    expect(msg).toContain('Gmail requires an app-specific password')
    expect(msg).toContain('regular account password will NOT work')
    expect(msg).toContain('two-factor authentication')
    expect(msg).toContain('EMAIL_PASSWORD')
    expect(msg).toContain('EMAIL_USERNAME')
    // Original server response is preserved for the agent
    expect(msg).toContain('Username and Password not accepted')
    expect(msg).toContain(GUIDE_URL)
  })

  it('maps imapflow authenticationFailed for a non-app-password domain to a generic credential hint', () => {
    const err = mailError('Authentication failed', {
      authenticationFailed: true,
      responseText: 'Invalid credentials (Failure)'
    })
    const msg = describeEmailError(err, {
      transport: 'IMAP',
      address: 'agent@corp.example',
      host: 'imap.corp.example',
      port: 993
    })

    expect(msg).toContain('IMAP authentication failed for agent@corp.example')
    expect(msg).toContain('EMAIL_USERNAME')
    expect(msg).toContain('EMAIL_PASSWORD')
    // Generic path still mentions app passwords exist, but names no provider
    expect(msg).toContain('app-specific password')
    expect(msg).not.toContain('Gmail')
    expect(msg).toContain(GUIDE_URL)
  })

  it('detects app-password providers for iCloud and Yahoo domains too', () => {
    for (const [address, provider] of [
      ['a@icloud.com', 'iCloud Mail'],
      ['a@me.com', 'iCloud Mail'],
      ['a@yahoo.com', 'Yahoo Mail'],
      ['a@fastmail.com', 'Fastmail']
    ] as const) {
      const msg = describeEmailError(mailError('auth', { code: 'EAUTH' }), {
        transport: 'SMTP',
        address
      })
      expect(msg).toContain(`${provider} requires an app-specific password`)
    }
  })

  it('maps ECONNREFUSED to a host/port hint mentioning auto-detection fallback and config override', () => {
    const err = mailError('connect ECONNREFUSED 192.0.2.1:993', { code: 'ECONNREFUSED' })
    const msg = describeEmailError(err, {
      transport: 'IMAP',
      address: 'agent@corp.example',
      host: 'imap.corp.example',
      port: 993
    })

    expect(msg).toContain('Could not reach the IMAP server at imap.corp.example:993')
    expect(msg).toContain('auto-detected from the email domain')
    expect(msg).toContain('imap.{domain}:993 / smtp.{domain}:465')
    expect(msg).toContain('"imap": {"host", "port"}')
    expect(msg).toContain(GUIDE_URL)
  })

  it('maps SMTP 552 size rejection to an attachment-size hint', () => {
    const err = mailError('Message failed: 552 5.3.4 Message size exceeds fixed maximum message size', {
      responseCode: 552,
      response: '552 5.3.4 Message size exceeds fixed maximum message size'
    })
    const msg = describeEmailError(err, {
      transport: 'SMTP',
      address: 'agent@gmail.com',
      host: 'smtp.gmail.com',
      port: 465
    })

    expect(msg).toContain('rejected the message as too large')
    expect(msg).toContain('size limit')
    expect(msg).toContain('remove or shrink the attachments')
    expect(msg).toContain(GUIDE_URL)
  })

  it('maps SMTP 550 recipient rejection to a check-the-address hint', () => {
    const err = mailError('550 5.1.1 The email account that you tried to reach does not exist', {
      responseCode: 550
    })
    const msg = describeEmailError(err, {
      transport: 'SMTP',
      address: 'agent@gmail.com'
    })

    expect(msg).toContain('refused to deliver the message')
    expect(msg).toContain('recipient address is a valid, existing email address')
    expect(msg).toContain(GUIDE_URL)
  })

  it('maps certificate failures to a hostname-mismatch hint', () => {
    const err = mailError('unable to verify the first certificate', {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    })
    const msg = describeEmailError(err, {
      transport: 'IMAP',
      host: 'imap.corp.example',
      port: 993
    })

    expect(msg).toContain('TLS certificate verification failed')
    expect(msg).toContain('imap.corp.example:993')
    expect(msg).toContain(GUIDE_URL)
  })

  it('passes unrecognized errors through with the server detail and no guide link', () => {
    const err = mailError('kaboom', { responseText: 'weird server mood' })
    const msg = describeEmailError(err, { transport: 'IMAP' })

    expect(msg).toContain('kaboom')
    expect(msg).toContain('Server: weird server mood')
    expect(msg).not.toContain('Setup guide:')
  })
})

describe('EmailAdapter error surfacing', () => {
  it('start() surfaces a gmail auth failure with the app-password hint through log and thrown error', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx('agent@gmail.com')
    globalThis.__emailErrMocks.nextConnectError = mailError('Authentication failed', {
      authenticationFailed: true,
      responseText: 'Application-specific password required'
    })

    await expect(adapter.start(ctx)).rejects.toThrow(/Gmail requires an app-specific password/)
    expect(adapter.status()).toBe('error')

    const errLog = ctx.logs.find(l => l.level === 'error' && l.msg.startsWith('IMAP connect failed:'))
    expect(errLog).toBeTruthy()
    expect(errLog!.msg).toContain('Application-specific password required')
    expect(errLog!.msg).toContain('two-factor authentication')
    expect(errLog!.msg).toContain(GUIDE_URL)
  })

  it('start() without credentials throws an actionable message with the setup guide', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    ;(ctx as unknown as { getCredential: (k: string) => string | null }).getCredential = () => null

    await expect(adapter.start(ctx)).rejects.toThrow(/EMAIL_USERNAME and\/or EMAIL_PASSWORD/)
    await expect(adapter.start(ctx)).rejects.toThrow(/app-specific password/)
    await expect(adapter.start(ctx)).rejects.toThrow(/Setup guide:/)
  })

  it('send() maps an SMTP 552 rejection to the size hint in DeliveryResult.error', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx('agent@gmail.com')
    await adapter.start(ctx)

    globalThis.__emailErrMocks.sendMailImpl = async () => {
      throw mailError('Message failed: 552 message size exceeds maximum', { responseCode: 552 })
    }
    const result = await adapter.send({
      id: 'm1',
      recipientId: 'friend@example.com',
      payload: 'hello',
      attachments: [{ path: 'a', filename: 'big.zip', mimeType: 'application/zip', size: 5, data: Buffer.from('x') }]
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('rejected the message as too large')
    expect(result.error).toContain('remove or shrink the attachments')
    expect(result.error).toContain(GUIDE_URL)
    await adapter.stop()
  })

  it('send() aborts before the SMTP transaction when an attachment has no data, naming the file', async () => {
    const adapter = new EmailAdapter()
    const ctx = makeCtx()
    await adapter.start(ctx)

    const sendMailSpy = vi.fn()
    globalThis.__emailErrMocks.sendMailImpl = async () => {
      sendMailSpy()
      return { messageId: 'x' }
    }
    const result = await adapter.send({
      id: 'm2',
      recipientId: 'friend@example.com',
      payload: 'hello',
      attachments: [{ path: 'missing.pdf', filename: 'missing.pdf', mimeType: 'application/pdf', size: 0 }]
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('NOT sent')
    expect(result.error).toContain('"missing.pdf"')
    expect(result.error).toContain(GUIDE_URL)
    // Nothing went out — one transaction means abort must happen before sendMail
    expect(sendMailSpy).not.toHaveBeenCalled()
    await adapter.stop()
  })

  it('send() while disconnected returns an actionable not-connected error with the guide', async () => {
    const adapter = new EmailAdapter()
    const result = await adapter.send({ id: 'm3', recipientId: 'a@b.c', payload: 'hi' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('not connected')
    expect(result.error).toContain('EMAIL_USERNAME/EMAIL_PASSWORD')
    expect(result.error).toContain(GUIDE_URL)
  })
})
