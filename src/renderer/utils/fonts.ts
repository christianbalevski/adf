/**
 * Is a font family available on this machine? `document.fonts.check()` is
 * useless for system fonts (it answers "true" for anything it has no
 * FontFace for), so this is the classic width probe: render a string in the
 * candidate family with a generic fallback and compare against the fallback
 * alone. Two fallbacks guard against the candidate metrically matching one.
 */
const cache = new Map<string, boolean>()
const PROBE = 'mmmmmmmmmmlllllllllliiiiiiiiiiWWWWWWWWWW0123456789'

export function isFontInstalled(family: string): boolean {
  const name = family.trim().replace(/["']/g, '')
  if (!name) return false
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  let installed = false
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      for (const generic of ['monospace', 'serif']) {
        ctx.font = `72px ${generic}`
        const base = ctx.measureText(PROBE).width
        ctx.font = `72px '${name}', ${generic}`
        if (ctx.measureText(PROBE).width !== base) { installed = true; break }
      }
    }
  } catch { /* no canvas (tests) — report unknown as not installed */ }
  cache.set(name, installed)
  return installed
}
