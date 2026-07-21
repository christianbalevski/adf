/**
 * Platform-aware modifier-key labels. Handlers accept BOTH metaKey and
 * ctrlKey everywhere, so commands work identically on every OS — these
 * constants only fix what the UI *shows*: ⌘/⌥/⇧ glyphs are meaningless on
 * Windows/Linux keyboards, which label the same keys Ctrl and Alt.
 */
export const IS_MAC = window.adfApi?.platform === 'darwin'

/** Primary command modifier: ⌘ on mac, Ctrl elsewhere. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'
/** Alternate modifier: ⌥ on mac, Alt elsewhere. */
export const ALT_KEY = IS_MAC ? '⌥' : 'Alt'
/** Shift: the glyph reads fine on mac, the word elsewhere. */
export const SHIFT_KEY = IS_MAC ? '⇧' : 'Shift'
