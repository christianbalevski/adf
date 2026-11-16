import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type Mounted } from './support/host-render'

;(globalThis as { React?: typeof React }).React = React

const api = vi.hoisted(() => ({ getSkillsCatalog: vi.fn() }))
vi.mock('../../../src/renderer/components/settings/settings-runtime', () => ({ useSettingsApi: () => api }))
import { SkillSourceCount } from '../../../src/renderer/components/settings/SkillSourceCount'

let ui: Mounted | undefined
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
afterEach(() => { expect(ui?.errors).toEqual([]); ui?.unmount(); api.getSkillsCatalog.mockReset() })

describe('saved skill source counts', () => {
  it.each([
    [{ ok: true, entries: [{ name: 'one' }, { name: 'two' }] }, '2 skills'],
    [{ ok: true, entries: [], discovered: { packages: [{ dir: 'one' }] } }, '1 skill'],
    [{ ok: true, entries: [] }, '0 skills'],
  ])('counts catalog entries or discovered packages', async (source, label) => {
    api.getSkillsCatalog.mockResolvedValue(source)
    ui = mount(<SkillSourceCount url="https://example.com/skills" />)
    await settle()
    expect(ui.text()).toBe(label)
    expect(api.getSkillsCatalog).toHaveBeenCalledExactlyOnceWith('https://example.com/skills')
  })

  it('shows loading until discovery finishes, then reports a failed read without a false zero', async () => {
    let finish!: (value: unknown) => void
    api.getSkillsCatalog.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    ui = mount(<SkillSourceCount url="https://example.com/skills" />)
    await settle()
    expect(ui.text()).toBe('Loading…')
    finish({ ok: false, error: 'HTTP 404' })
    await settle()
    expect(ui.text()).toBe('Unavailable')
    expect(ui.find((node) => node.props.title === 'HTTP 404')).toHaveLength(1)
  })
})
