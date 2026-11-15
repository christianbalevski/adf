/** The part of js-yaml (ships no declarations) that skill-manifest import reads with. */
declare module 'js-yaml' {
  export const CORE_SCHEMA: unknown
  export function load(text: string, options?: { schema?: unknown; json?: boolean; filename?: string }): unknown
}
