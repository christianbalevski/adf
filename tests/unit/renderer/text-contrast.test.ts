/**
 * Grey text must meet WCAG 2.2 AA. The Tailwind greys are one remapped ramp
 * (globals.css): light 400 (#858b99) is 3.41:1 on white, and dark 500/600
 * (#6b707c, #474b54) are 3.89 and 2.21 on the dark window. Faint text uses
 * the --adf-ui-text-subtle token; off-state icons use --adf-ui-icon-muted;
 * inactive controls use --adf-ui-text-disabled.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '../../..')
const RENDERER = join(ROOT, 'src/renderer')
const GREY = '(?:neutral|zinc|gray|slate|stone)'

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(path)
  }
  return out
}

/** Every grey text class with its variant chain, e.g. `dark:hover:text-neutral-500`. */
function greyTextClasses(src: string): { variants: string[]; shade: number; line: number }[] {
  const re = new RegExp(`(?<![\\w\\-\\[/])((?:[\\w\\-\\[\\]&>*]+:)*)!?text-${GREY}-(\\d+)(?:/\\d+)?(?![\\w\\-\\]])`, 'g')
  const found: { variants: string[]; shade: number; line: number }[] = []
  for (const m of src.matchAll(re)) {
    found.push({
      variants: m[1].split(':').filter(Boolean),
      shade: Number(m[2]),
      line: src.slice(0, m.index).split('\n').length,
    })
  }
  return found
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `--name: #hex;` declarations in every block whose selector is exactly `selector`. */
function block(css: string, selector: string): Record<string, string> {
  const vars: Record<string, string> = {}
  let start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  while (start >= 0) {
    const body = css.slice(start, css.indexOf('}', start))
    for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[m[1]] = m[2]
    start = css.indexOf(`${selector} {`, start + 1)
  }
  return vars
}

describe('grey text contrast', () => {
  it('uses no light-mode 400 grey text in src/renderer', () => {
    const hits: string[] = []
    for (const file of sources(RENDERER)) {
      for (const c of greyTextClasses(readFileSync(file, 'utf8'))) {
        if (c.shade === 400 && !c.variants.includes('dark')) {
          hits.push(`${relative(ROOT, file)}:${c.line} ${[...c.variants, `text-*-400`].join(':')}`)
        }
      }
    }
    expect(hits, 'use text-[var(--adf-ui-text-subtle)]').toEqual([])
  })

  it('uses no dark-mode 500 or 600 grey text in src/renderer', () => {
    const hits: string[] = []
    for (const file of sources(RENDERER)) {
      for (const c of greyTextClasses(readFileSync(file, 'utf8'))) {
        if ((c.shade === 500 || c.shade === 600) && c.variants.includes('dark')) {
          hits.push(`${relative(ROOT, file)}:${c.line} ${[...c.variants, `text-*-${c.shade}`].join(':')}`)
        }
      }
    }
    expect(hits, 'use text-[var(--adf-ui-text-subtle)] or text-[var(--adf-ui-icon-muted)]').toEqual([])
  })

  it('keeps the contrast tokens above their WCAG floors', () => {
    const globals = readFileSync(join(RENDERER, 'styles/globals.css'), 'utf8')
    const brand = readFileSync(join(RENDERER, 'styles/brand-tokens.css'), 'utf8')
    const light = { ...block(brand, ':root'), ...block(globals, ':root') }
    const dark = { ...block(brand, ":root[data-theme='dark']"), ...block(globals, '.dark') }
    // Light neutral-100 / dark neutral-700: the chip fills that take text-subtle-on-fill.
    const fill = { light: '#eceef3', dark: '#333a49' }

    for (const [theme, t] of [['light', light], ['dark', dark]] as const) {
      const surfaces = [t['--paper'], t['--paper-raised'], t['--paper-sunken']]
      for (const bg of surfaces) {
        expect(ratio(t['--ink-faint'], bg), `${theme} text-subtle on ${bg}`).toBeGreaterThanOrEqual(4.5)
        expect(ratio(t['--adf-ui-icon-muted'], bg), `${theme} icon-muted on ${bg}`).toBeGreaterThanOrEqual(3)
      }
      expect(ratio(t['--adf-ui-icon-muted'], t['--rule']), `${theme} icon-muted on --rule`).toBeGreaterThanOrEqual(3)
      for (const bg of [t['--rule'], fill[theme]]) {
        expect(ratio(t['--adf-ui-text-subtle-on-fill'], bg), `${theme} text-subtle-on-fill on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
