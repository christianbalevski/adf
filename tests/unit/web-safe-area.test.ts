import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const WEB = join(__dirname, '../../src/web')

// index.html opts into viewport-fit=cover, which lets the page draw under the
// status bar and notch. Every layout has to inset for that, not just the compact
// one: an iPad home-screen app in landscape is wide, and without the inset its
// title bar sits under the status bar.
describe('browser Studio safe area', () => {
  it('insets body by the safe area in every layout when the page covers the viewport', () => {
    expect(readFileSync(join(WEB, 'index.html'), 'utf8')).toMatch(/viewport-fit=cover/)
    const selectors: string[] = []
    postcss.parse(readFileSync(join(WEB, 'web.css'), 'utf8')).walkDecls('padding', (decl) => {
      const rule = decl.parent as postcss.Rule
      if (decl.value.includes('env(safe-area-inset-top)') && rule.selector) selectors.push(rule.selector)
    })
    expect(selectors).toContain('body')
  })
})
