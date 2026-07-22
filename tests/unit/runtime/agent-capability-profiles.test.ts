import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITIES,
  AGENT_PROFILE_NAMES,
  AGENT_PROFILES,
  ASYNC_TEARDOWN_CAPABILITIES,
  isSyncSafeAgentProfile,
  profileHasAsyncTeardown,
} from '../../../src/main/runtime/agent-capability-profiles'

describe('agent capability profiles', () => {
  it('declares every capability for every profile', () => {
    for (const profileName of AGENT_PROFILE_NAMES) {
      expect(Object.keys(AGENT_PROFILES[profileName]).sort()).toEqual(
        [...AGENT_CAPABILITIES].sort(),
      )
    }
  })

  it('enables timers for live headless agents', () => {
    expect(AGENT_PROFILES.headlessLive.timers).toBe(true)
  })

  it('disables timers for benchmark agents', () => {
    expect(AGENT_PROFILES.benchmark.timers).toBe(false)
  })

  it('keeps synchronous profiles free of async teardown subsystems', () => {
    for (const profileName of ['headlessLive', 'benchmark'] as const) {
      expect(isSyncSafeAgentProfile(profileName)).toBe(true)
      expect(profileHasAsyncTeardown(profileName)).toBe(false)

      for (const capability of ASYNC_TEARDOWN_CAPABILITIES) {
        expect(AGENT_PROFILES[profileName][capability]).toBe(false)
      }
    }
  })

  it('identifies full profiles as requiring async teardown', () => {
    for (const profileName of ['studioForeground', 'studioBackground', 'daemon'] as const) {
      expect(profileHasAsyncTeardown(profileName)).toBe(true)
      expect(isSyncSafeAgentProfile(profileName)).toBe(false)
    }
  })
})
