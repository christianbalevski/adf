/**
 * Self-test for the alf-mcp server against ADF Studio's real crypto path.
 *
 *   npx tsx tools/alf-mcp/selftest.ts
 *
 * A) alf-mcp wire output → Studio's actual ingress pipeline (verify outer sig,
 *    decrypt, verify payload sig) with a stubbed recipient workspace.
 * B) Studio's actual egress pipeline (sign, encrypt, sign) → HTTP POST to a
 *    live alf-mcp inbox server → assert stored, decrypted, verified.
 * C) Negative: tampered messages are rejected with 403 in both directions.
 */

import { spawn } from 'child_process'
import { readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

import { createDefaultPipeline, type MessagingPipelineContext } from '../../src/main/services/alf-pipeline'
import { buildAlfMessage } from '../../src/main/utils/alf-message'
import { generateMnemonic, deriveOwnerIdentity } from '../../src/main/crypto/mnemonic-identity'
import { buildMessage, prepareWire, type Identity } from './core'

function makeIdentity(): Identity {
  const mnemonic = generateMnemonic()
  const { privateKeyPkcs8, publicKeySpki, did } = deriveOwnerIdentity(mnemonic)
  return { did, mnemonic, privateKeyPkcs8, publicKeySpki }
}

function ctxFor(identity: Identity, remoteDid: string, direction: 'ingress' | 'egress'): MessagingPipelineContext {
  return {
    direction,
    workspace: {
      getSigningKeys: () => ({ privateKey: identity.privateKeyPkcs8, publicKey: identity.publicKeySpki })
    } as never,
    localDid: identity.did,
    remoteDid,
    isLocal: false,
    security: { allow_unsigned: false, level: 2, require_signature: true, require_payload_signature: true },
    derivedKey: null
  }
}

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.error(`PASS  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`, detail ?? '')
  }
}

async function main(): Promise<void> {
  const me = makeIdentity() // plays the alf-mcp agent
  const studio = makeIdentity() // plays an ADF Studio agent
  const pipeline = createDefaultPipeline()

  // --- A) alf-mcp egress → Studio ingress ---
  const outMsg = buildMessage(
    {
      to: studio.did,
      content: 'hello from claude',
      replyTo: 'http://127.0.0.1:7411/claude/mesh/inbox',
      subject: 'e2e-a',
      network: 'devnet'
    },
    me
  )
  const wire = prepareWire(outMsg, me, true)
  check('A: payload is encrypted on the wire', wire.payload.content_type === 'application/x-adf-encrypted')

  const inResult = await pipeline.processIngress(wire, ctxFor(studio, me.did, 'ingress'))
  check('A: Studio ingress accepts', !inResult.rejected, inResult.rejected)
  if (!inResult.rejected) {
    const m = inResult.data
    check('A: outer signature verified', m.meta?.message_verified === true)
    check('A: payload decrypted', m.meta?.payload_encrypted === true && m.payload.content === 'hello from claude')
    check('A: payload signature verified', m.meta?.payload_verified === true)
  }

  // --- C) tampered wire → Studio ingress rejects ---
  const tampered = { ...wire, timestamp: new Date(Date.now() + 60_000).toISOString() }
  const tamperResult = await pipeline.processIngress(tampered, ctxFor(studio, me.did, 'ingress'))
  check('C: tampered message rejected by Studio ingress', tamperResult.rejected?.code === 403, tamperResult.rejected)

  // --- B) Studio egress → live alf-mcp inbox over HTTP ---
  const repoRoot = resolve(__dirname, '..', '..')
  const dataDir = join(tmpdir(), `alf-mcp-selftest-${Date.now()}`)
  const child = spawn('npx', ['tsx', 'tools/alf-mcp/index.ts'], {
    cwd: repoRoot,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ALF_MCP_DATA_DIR: dataDir, ALF_MCP_PORT: '7411', ALF_MCP_BIND: '127.0.0.1', ALF_MCP_MDNS: '0' }
  })
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`  [server] ${d}`))

  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await fetch('http://127.0.0.1:7411/health').then((r) => r.ok).catch(() => false)
    }
    check('B: alf-mcp server up', up)
    if (!up) return

    const card = (await (await fetch('http://127.0.0.1:7411/claude/mesh/card')).json()) as { did: string }
    check('B: card has DID', typeof card.did === 'string' && card.did.startsWith('did:key:'))

    let msg = buildAlfMessage({
      from: studio.did,
      to: card.did,
      replyTo: 'http://127.0.0.1:7295/agent-1/mesh/inbox',
      network: 'devnet',
      content: 'hello from studio',
      subject: 'e2e-b',
      senderAlias: 'agent-1'
    })
    const egress = await pipeline.processEgress(msg, ctxFor(studio, card.did, 'egress'))
    check('B: Studio egress ok', !egress.rejected, egress.rejected)
    msg = egress.data
    check('B: Studio egress encrypted to me', msg.payload.content_type === 'application/x-adf-encrypted')

    const res = await fetch('http://127.0.0.1:7411/claude/mesh/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg)
    })
    const body = (await res.json()) as { message_id?: string }
    check('B: inbox accepts with 202', res.status === 202, { status: res.status, body })

    await new Promise((r) => setTimeout(r, 300))
    const inboxFile = JSON.parse(readFileSync(join(dataDir, 'inbox.json'), 'utf-8')) as Array<{
      encrypted: boolean
      verified: { message: boolean | null; payload: boolean | null }
      message: { payload: { content: unknown }; from: string }
    }>
    const rec = inboxFile[inboxFile.length - 1]
    check('B: stored decrypted content', rec?.message.payload.content === 'hello from studio', rec?.message.payload)
    check('B: outer sig verified', rec?.verified.message === true)
    check('B: payload sig verified', rec?.verified.payload === true)
    check('B: marked encrypted', rec?.encrypted === true)

    const bad = { ...msg, timestamp: new Date(Date.now() + 60_000).toISOString() }
    const badRes = await fetch('http://127.0.0.1:7411/claude/mesh/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bad)
    })
    check('B: tampered POST rejected 403', badRes.status === 403, badRes.status)
  } finally {
    // shell:true wraps the server in cmd.exe — child.kill() would only kill the
    // shell and orphan the node tree (which also holds our stdio pipes open).
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
    await new Promise((r) => setTimeout(r, 500))
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

main()
  .then(() => {
    console.error(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('fatal:', err)
    process.exit(1)
  })
