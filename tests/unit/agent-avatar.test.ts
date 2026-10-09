import { describe, expect, it } from 'vitest'
import {
  agentAvatarEmoji,
  isAgentAvatarMode,
  selectAgentAvatar
} from '../../src/renderer/components/orbital/agent-avatar'
import { pickAgentIcon } from '../../src/shared/constants/agent-icons'

const DID = 'did:key:z6MkfixtureAgentOne'
const ID = '0b6f6c1e-3f2a-4c1d-9a51-7d3b2e9c4a10'

describe('selectAgentAvatar', () => {
  it('orbital mode draws the orbital from the seed and ignores the icon', () => {
    expect(selectAgentAvatar('orbital', { seed: DID, icon: '🦊', iconSeed: ID })).toEqual({ kind: 'orbital', seed: DID })
    expect(selectAgentAvatar('orbital', { seed: null, icon: '🦊' })).toEqual({ kind: 'orbital', seed: null })
  })

  it('emoji mode draws the configured icon', () => {
    expect(selectAgentAvatar('emoji', { seed: DID, icon: '🦊', iconSeed: ID })).toEqual({ kind: 'emoji', emoji: '🦊' })
  })

  it('emoji mode falls back to pickAgentIcon(iconSeed), then pickAgentIcon(seed)', () => {
    expect(selectAgentAvatar('emoji', { seed: DID, icon: '', iconSeed: ID })).toEqual({ kind: 'emoji', emoji: pickAgentIcon(ID) })
    expect(selectAgentAvatar('emoji', { seed: DID, icon: undefined })).toEqual({ kind: 'emoji', emoji: pickAgentIcon(DID) })
  })

  it('emoji mode with nothing to draw from yields null', () => {
    expect(selectAgentAvatar('emoji', { seed: null })).toEqual({ kind: 'emoji', emoji: null })
  })
})

describe('agentAvatarEmoji', () => {
  it('keeps only the first grapheme of the icon', () => {
    expect(agentAvatarEmoji('🦊🐙', null)).toBe('🦊')
    expect(agentAvatarEmoji('👩‍💻x', null)).toBe('👩‍💻')
  })

  it('treats a blank icon as missing', () => {
    expect(agentAvatarEmoji('  ', ID)).toBe(pickAgentIcon(ID))
  })
})

describe('isAgentAvatarMode', () => {
  it('accepts only the two modes', () => {
    expect(isAgentAvatarMode('orbital')).toBe(true)
    expect(isAgentAvatarMode('emoji')).toBe(true)
    expect(isAgentAvatarMode('icon')).toBe(false)
    expect(isAgentAvatarMode(undefined)).toBe(false)
  })
})
