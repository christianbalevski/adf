import { describe, expect, it } from 'vitest'
import { suppressPanContextMenu } from '../../../src/renderer/components/mesh/fleet-pan-context-menu'

function opensContextMenu(target: EventTarget, button = 2): boolean {
  const menu = new Event('contextmenu', { cancelable: true })
  return target.dispatchEvent(Object.assign(menu, { button }))
}

describe('Fleet right-pan context menu', () => {
  it('cancels only the released pan’s menu', () => {
    const target = new EventTarget()
    suppressPanContextMenu(target)
    expect(opensContextMenu(target)).toBe(false)
    expect(opensContextMenu(target)).toBe(true)
  })

  it.each(['pointerdown', 'keydown', 'blur'])('restores menus on %s', (event) => {
    const target = new EventTarget()
    suppressPanContextMenu(target)
    target.dispatchEvent(new Event(event))
    expect(opensContextMenu(target)).toBe(true)
  })

  it('leaves a keyboard menu alone and removes all listeners on cleanup', () => {
    const target = new EventTarget()
    const cleanup = suppressPanContextMenu(target)
    expect(opensContextMenu(target, 0)).toBe(true)
    cleanup()
    expect(opensContextMenu(target)).toBe(true)
  })
})
