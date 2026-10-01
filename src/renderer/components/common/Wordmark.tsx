/**
 * The `.ADF` wordmark (adf-org/brand/logo), swapped light/dark by the `.dark`
 * class on <html>. Outlined SVGs only — never live text. The artboard already
 * includes the brand clear space, so `height` is the artboard height; keep it
 * at 20px or more (brand minimum: 40px wide letters, ~14px cap height).
 */
import wordmarkLight from '../../assets/brand/adf-wordmark-light.svg'
import wordmarkDark from '../../assets/brand/adf-wordmark-dark.svg'

// Artboard aspect ratio (viewBox 5185 x 2330).
const ASPECT = 5185 / 2330

export function Wordmark({ height = 22, className = '' }: { height?: number; className?: string }) {
  const style = { height, width: Math.round(height * ASPECT) }
  return (
    <span role="img" aria-label="ADF Studio" className={`inline-flex shrink-0 ${className}`}>
      <img src={wordmarkLight} alt="" aria-hidden draggable={false} style={style} className="block dark:hidden" />
      <img src={wordmarkDark} alt="" aria-hidden draggable={false} style={style} className="hidden dark:block" />
    </span>
  )
}
