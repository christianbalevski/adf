// The cloud metadata block holds for every caller, and link-local stays
// blocked unless a caller opts in (peer fetch does; sys_fetch does not).
import { describe, expect, it } from 'vitest'
import { checkFetchTarget, isCloudMetadataIp } from '../../../src/main/utils/ssrf-guard'

describe('cloud metadata and link-local', () => {
  it('names the metadata addresses', () => {
    for (const ip of ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254', 'FD00:0EC2:0:0:0:0:0:254', '::ffff:169.254.169.254', '[fd00:ec2::254]']) {
      expect(isCloudMetadataIp(ip)).toBe(true)
    }
    for (const ip of ['169.254.10.20', 'fe80::1', 'fd00::1', '10.0.0.1']) expect(isCloudMetadataIp(ip)).toBe(false)
  })

  it('metadata is blocked even with allowLocal and allowLinkLocal; link-local only with allowLinkLocal', async () => {
    const open = { allowLocal: true, allowLinkLocal: true }
    expect(await checkFetchTarget('http://169.254.169.254/', open)).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('http://[fd00:ec2::254]/', open)).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('http://169.254.170.2/', open)).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('http://169.254.10.20/', open)).toBeNull()
    expect(await checkFetchTarget('http://[fe80::1]/', open)).toBeNull()
    // Default (sys_fetch) policy unchanged: link-local blocked even with allowLocal.
    expect(await checkFetchTarget('http://169.254.10.20/', { allowLocal: true })).toMatch(/link-local/)
    expect(await checkFetchTarget('http://[fe80::1]/', { allowLocal: true })).toMatch(/link-local/)
    // Daemon port still refused with everything open.
    expect(await checkFetchTarget('http://127.0.0.1:7385/', { ...open, daemonPort: 7385 })).toMatch(/daemon/)
  })
})

describe('IPv4-mapped IPv6 in the hex spelling', () => {
  it('classifies as its IPv4 address (the URL parser writes ::ffff:a9fe:a9fe)', async () => {
    expect(new URL('http://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]')
    expect(isCloudMetadataIp('::ffff:a9fe:a9fe')).toBe(true)
    expect(await checkFetchTarget('http://[::ffff:169.254.169.254]/', { allowLocal: true, allowLinkLocal: true })).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('http://[::ffff:169.254.10.20]/', { allowLocal: true })).toMatch(/link-local/)
    expect(await checkFetchTarget('http://[::ffff:127.0.0.1]:7385/', { daemonPort: 7385 })).toMatch(/daemon/)
    expect(await checkFetchTarget('http://[::ffff:10.0.0.1]/')).toMatch(/private-network/)
  })
})
