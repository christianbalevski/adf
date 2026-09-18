/**
 * Names for agents the user did not name: an adjective and a plant, joined
 * with a hyphen ("steady-fern"). Two words from two lists keep collisions
 * rare across a folder of quick-made agents; the caller still checks the
 * folder, and the file path gets a " (2)" suffix if it has to.
 *
 * The plant list stays clear of the registry agents (ash, aspen, cedar, ivy,
 * oak, sage) so "the sage I made" and "the sage from the registry" cannot be
 * confused.
 */

export const AGENT_NAME_ADJECTIVES = [
  'amber', 'bold', 'brisk', 'calm', 'clever', 'cosy', 'deft', 'eager', 'fair', 'fond',
  'gentle', 'glad', 'hardy', 'humble', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'merry',
  'mild', 'nimble', 'patient', 'plucky', 'proud', 'quick', 'quiet', 'ready', 'rosy', 'sharp',
  'silver', 'sly', 'snug', 'spry', 'steady', 'sunny', 'swift', 'tidy', 'trusty', 'warm',
  'wise', 'witty', 'zesty', 'bright', 'brave', 'cheery', 'daring', 'earnest', 'friendly', 'honest',
] as const

export const AGENT_NAME_PLANTS = [
  'alder', 'basil', 'birch', 'bramble', 'briar', 'clover', 'cypress', 'dahlia', 'elm', 'fern',
  'fig', 'hazel', 'heather', 'holly', 'iris', 'jasmine', 'juniper', 'laurel', 'lilac', 'linden',
  'lotus', 'maple', 'marigold', 'mint', 'moss', 'myrtle', 'nettle', 'olive', 'orchid', 'pine',
  'poppy', 'primrose', 'reed', 'rowan', 'rue', 'sorrel', 'spruce', 'thistle', 'thyme', 'tulip',
  'violet', 'willow', 'yarrow', 'yew', 'zinnia', 'acorn', 'aster', 'cedarwood', 'daisy', 'larch',
] as const

export interface GenerateAgentNameOptions {
  /** True when a name is already in use; the generator tries again. */
  taken?: (name: string) => boolean
  /** Uniform [0, 1) source; defaults to Math.random. Injected by tests. */
  random?: () => number
  /** Attempts before giving back the last candidate regardless. */
  attempts?: number
}

/**
 * "adjective-plant", lower case, hyphenated. Tries `attempts` times to find
 * one `taken` rejects; after that returns the last candidate, and the file
 * layer's " (n)" suffix keeps the path unique.
 */
export function generateAgentName(options: GenerateAgentNameOptions = {}): string {
  const random = options.random ?? Math.random
  const taken = options.taken ?? (() => false)
  const attempts = Math.max(1, options.attempts ?? 24)
  const pick = <T,>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]
  let candidate = ''
  for (let i = 0; i < attempts; i++) {
    candidate = `${pick(AGENT_NAME_ADJECTIVES)}-${pick(AGENT_NAME_PLANTS)}`
    if (!taken(candidate)) return candidate
  }
  return candidate
}
