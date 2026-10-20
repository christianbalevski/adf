import { describe, expect, it } from 'vitest'
import { composerMedia, gateAttachments, type UploadKind } from '../../../src/renderer/utils/attachment-gate'
import type { LoopMedia } from '../../../src/shared/types/media.types'

const kindOf = (file: { name: string }): UploadKind => {
  const ext = file.name.split('.').pop()
  return ext === 'png' ? 'image' : ext === 'wav' ? 'audio' : ext === 'mp4' ? 'video' : 'file'
}
const files = [{ name: 'photo.png' }, { name: 'voice.wav' }, { name: 'clip.mp4' }, { name: 'notes.pdf' }]

describe('composer attachment gate', () => {
  it('refuses media the loop cannot take before upload, with the runtime reason', () => {
    // A running loop on a connector without audio or video, image turned on.
    const media: LoopMedia = {
      support: { image: true, audio: false, video: false },
      refusals: { audio: 'Anthropic does not accept audio input', video: 'Anthropic does not accept video input' },
    }
    const { accepted, refused } = gateAttachments(files, kindOf, media)
    expect(accepted.map(file => file.name)).toEqual(['photo.png', 'notes.pdf'])
    expect(refused).toEqual([
      { name: 'voice.wav', reason: 'Anthropic does not accept audio input' },
      { name: 'clip.mp4', reason: 'Anthropic does not accept video input' },
    ])
  })

  it('uses the runtime set over the toggles: a toggle cannot widen the connector', () => {
    const running: LoopMedia = { support: { image: true, audio: false, video: false }, refusals: { video: 'Anthropic does not accept video input' } }
    const media = composerMedia(running, { image: true, audio: true, video: true })
    expect(gateAttachments([{ name: 'clip.mp4' }], kindOf, media).refused).toEqual([{ name: 'clip.mp4', reason: 'Anthropic does not accept video input' }])
  })

  it('falls back to the toggles before the agent runs, and still says why', () => {
    const media = composerMedia(null, { image: false, audio: true, video: true })
    const { accepted, refused } = gateAttachments(files, kindOf, media)
    expect(accepted.map(file => file.name)).toEqual(['voice.wav', 'clip.mp4', 'notes.pdf'])
    expect(refused).toEqual([{ name: 'photo.png', reason: "Image input is off in this agent's model settings" }])
  })
})
