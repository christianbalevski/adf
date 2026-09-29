// npm runs as npm.cmd on Windows, which Node only spawns through cmd.exe, so
// package names and versions reach a shell. Accept only plain registry specs.
const NAME = /^(@[\w.-]+\/)?[\w.-]+$/
const VERSION = /^[\w.^~*+-]+$/

/** Throws unless `name` (optionally `name@version`) and `version` are plain npm registry specs. */
export function assertNpmSpec(name: string, version?: string): void {
  const at = name.lastIndexOf('@')
  const bare = at > 0 ? name.slice(0, at) : name
  if (!NAME.test(bare)) throw new Error(`Invalid npm package name: ${name}`)
  for (const v of [at > 0 ? name.slice(at + 1) : undefined, version]) {
    if (v !== undefined && !VERSION.test(v)) throw new Error(`Invalid npm version: ${v}`)
  }
}
