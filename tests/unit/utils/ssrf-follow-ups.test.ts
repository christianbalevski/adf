// SSRF guard follow-ups from W1-D (tracker §6, owned by W4-B). Written
// first as a characterization of the guard as it was (E3); each fix commit
// flips the rows it changes.
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Scripted DNS answers per host name (in order); other names resolve for real. */
const dnsScript = vi.hoisted(() => new Map<string, string[]>())
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = (async (host: string, opts?: unknown) => {
    const answers = dnsScript.get(host)
    if (!answers || answers.length === 0) return real.lookup(host, opts as never)
    const address = answers.length > 1 ? answers.shift()! : answers[0]
    const family = address.includes(':') ? 6 : 4
    return (opts as { all?: boolean } | undefined)?.all ? [{ address, family }] : { address, family }
  }) as typeof real.lookup
  return { ...real, lookup, default: { ...real, lookup } }
})
import { checkFetchTarget, isCloudMetadataIp } from '../../../src/main/utils/ssrf-guard'
import { guardedFetch, isFetchFailure } from '../../../src/main/utils/guarded-fetch'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done())))) })

describe('NAT64 64:ff9b::/96 and 6to4 2002::/16 carry an IPv4 address', () => {
  it('before: classified as public IPv6, so the embedded address is not checked', async () => {
    // 64:ff9b::a9fe:a9fe is 169.254.169.254; 2002:a9fe:a9fe:: embeds it too.
    expect(isCloudMetadataIp('64:ff9b::a9fe:a9fe')).toBe(false)
    expect(await checkFetchTarget('http://[64:ff9b::a9fe:a9fe]/latest/')).toBeNull()
    expect(await checkFetchTarget('http://[2002:a9fe:a9fe::1]/latest/')).toBeNull()
    expect(await checkFetchTarget('http://[64:ff9b::c0a8:105]/')).toBeNull() // 192.168.1.5
  })
})

describe('cloud metadata endpoints beyond AWS/GCP 169.254.169.254', () => {
  it('before: EKS pod identity, Alibaba, Azure WireServer and OCI are not in the always-blocked list', async () => {
    const open = { allowLocal: true, allowLinkLocal: true }
    for (const ip of ['169.254.170.23', 'fd00:ec2::23', '100.100.100.200', '168.63.129.16', '192.0.0.192']) expect(isCloudMetadataIp(ip), ip).toBe(false)
    expect(await checkFetchTarget('http://169.254.170.23/v1/credentials', open)).toBeNull()
    expect(await checkFetchTarget('http://100.100.100.200/latest/meta-data', open)).toBeNull()
    expect(await checkFetchTarget('http://168.63.129.16/machine')).toBeNull()
  })
})

describe('a host name that does not resolve', () => {
  it('before: passes the guard (the fetch itself then fails or resolves differently)', async () => {
    expect(await checkFetchTarget('http://no-such-host.invalid/')).toBeNull()
  })
})

/** A non-loopback IPv4 address of this machine, if it has one. */
const OWN_ADDRESS = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null

describe('the daemon control port on an address of this host that is not loopback', () => {
  it.skipIf(!OWN_ADDRESS)('before: allowed once private addresses are (allowLocal), so a daemon bound to the network is reachable', async () => {
    expect(await checkFetchTarget(`http://${OWN_ADDRESS}:7385/runtime`, { allowLocal: true, daemonPort: 7385 })).toBeNull()
  })
})

describe('DNS rebinding between the guard\'s lookup and the connection', () => {
  it('before: the guard checks one answer, the connection makes its own lookup', async () => {
    const server = createServer((_req, res) => { res.end('reached') })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const port = (server.address() as { port: number }).port
    // The guard is told a public address; the connection does not use that
    // answer (here it cannot even resolve the made-up name).
    dnsScript.set('rebind.adf-test.invalid', ['93.184.216.34', '127.0.0.1'])
    const result = await guardedFetch(`http://rebind.adf-test.invalid:${port}/`, { maxBytes: 1024, timeoutMs: 5000, allowHttp: true })
    expect(isFetchFailure(result)).toBe(true)
    expect(isFetchFailure(result) && result.error).not.toMatch(/Blocked/)
  })
})
