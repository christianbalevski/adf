import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from '../../../src/renderer/components/common/Tooltip'

;(globalThis as { React?: typeof React }).React = React

// Capture the actual anchor handlers without needing a browser DOM. Browser
// QA separately exercises the synthesized mouse events after a touch tap.
const recorder = vi.hoisted(() => ({ anchor: null as Record<string, (event?: unknown) => void> | null }))
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return {
    ...original,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      if (type === 'span' && props.onMouseEnter) recorder.anchor = props as typeof recorder.anchor
      return (original.jsxDEV as (...args: unknown[]) => unknown)(type, props, ...rest)
    },
  }
})

function anchor(platform = 'web', compact = true) {
  vi.useFakeTimers()
  vi.stubGlobal('window', { adfApi: { platform }, matchMedia: () => ({ matches: compact }) })
  renderToStaticMarkup(<Tooltip tip="Home"><button>Home</button></Tooltip>)
  expect(recorder.anchor).not.toBeNull()
  return recorder.anchor!
}

afterEach(() => {
  recorder.anchor = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('tooltip input methods', () => {
  it('does not schedule a hover hint for touch or its synthesized mouseenter', () => {
    const handlers = anchor()
    handlers.onPointerEnter({ pointerType: 'touch' })
    handlers.onPointerDown({ pointerType: 'touch' })
    handlers.onMouseEnter()
    handlers.onFocus({ target: { matches: () => false } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still supports a mouse connected to a compact touch browser', () => {
    const handlers = anchor()
    handlers.onPointerEnter({ pointerType: 'mouse' })
    expect(vi.getTimerCount()).toBe(1)
    handlers.onPointerLeave({ pointerType: 'mouse' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending hint when the user switches to touch', () => {
    const handlers = anchor()
    handlers.onPointerEnter({ pointerType: 'mouse' })
    handlers.onPointerDown({ pointerType: 'touch' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains keyboard focus hints in compact browsers', () => {
    const handlers = anchor()
    handlers.onFocus({ target: { matches: () => true } })
    expect(vi.getTimerCount()).toBe(1)
    handlers.onBlur()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['darwin', true], ['web', false]])('retains existing hover handling on %s (compact match %s)', (platform, compact) => {
    const handlers = anchor(platform, compact)
    handlers.onMouseEnter()
    expect(vi.getTimerCount()).toBe(1)
    handlers.onMouseLeave()
    expect(vi.getTimerCount()).toBe(0)
  })
})
