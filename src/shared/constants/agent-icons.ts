/**
 * Curated pool of agent avatar icons. Every entry is a single emoji with
 * default emoji presentation (no variation selectors), chosen to read well
 * at small sizes: robots/tech, animals with character, tools, nature, and
 * distinctive objects. No faces, flags, or glyphs that render as text on macOS.
 */
export const AGENT_ICON_POOL: string[] = [
  // Robots & tech
  '🤖', '🦾', '📡', '🔭', '🔬', '🧭', '🧲', '🔋', '💡', '🧬', '🔮', '⚡',
  // Animals with character
  '🦊', '🦉', '🐙', '🦅', '🐺', '🦡', '🐢', '🦫', '🐝', '🦋', '🐋', '🦈', '🐉', '🦑', '🦜',
  // Tools & craft
  '🔨', '🪛', '🪚', '🧰', '📐', '🏹', '🔩',
  // Exploration & nature
  '🌋', '🗻', '🌊', '🌵', '🍄', '🌲',
  // Objects
  '🎯', '🎲', '🧩', '📦', '💎', '🧪', '📜', '🏺'
]

/**
 * Deterministically pick an icon for a seed string (e.g. an agent id).
 * Same seed always yields the same icon.
 */
export function pickAgentIcon(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }
  return AGENT_ICON_POOL[Math.abs(h) % AGENT_ICON_POOL.length]
}
