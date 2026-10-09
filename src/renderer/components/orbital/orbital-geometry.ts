/**
 * Bitmap geometry for cached orbital avatars. Changing any of these changes
 * the cached PNGs: bump ORBITAL_RENDER_REV (shared/utils/orbital-cache-key.ts).
 */

/** Logical size the shape is drawn at. Avatars show at 24 to 40 px, so the
 *  small-size styling (thicker rim, coarser grid) is the one that fits. */
export const ORBITAL_DRAW_SIZE = 40
/** Pixel size of one frame (static image, or one cell of the strip). Covers 40 px at 2.4x. */
export const ORBITAL_FRAME_PX = 96
/** Frames in the sprite strip: one full turn about the axis and one phase cycle. */
export const ORBITAL_STRIP_FRAMES = 24
/** Seconds for one pass through the strip. */
export const ORBITAL_STRIP_SECONDS = 4
