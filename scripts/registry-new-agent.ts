/**
 * Create a blank registry agent — a plain .adf with no identity, no owner,
 * no history — so it can be committed under registry/ and claimed by whoever
 * brings it home. Runs against the node ABI build of better-sqlite3:
 *
 *   node scripts/rebuild-for-node.mjs && npx tsx scripts/registry-new-agent.ts <name> [icon] [readme.md]
 *   npx electron-rebuild -f -o better-sqlite3   # back to the Electron ABI for `npm run dev`
 *
 * Then `node scripts/registry-index.mjs` to (re)write registry/index.json.
 * Editing the agent afterwards is the same as editing any agent: open it in
 * Studio, change it, and commit the file. Just run the index script again
 * and make sure it is still identity-free (the index script checks).
 */
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { AdfDatabase } from '../src/main/adf/adf-database'

const [name, icon, readmePath] = process.argv.slice(2)
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('usage: npx tsx scripts/registry-new-agent.ts <name: lowercase, digits, dashes> [icon] [readme.md]')
  process.exit(1)
}

const registryDir = resolve(__dirname, '..', 'registry')
const target = join(registryDir, `${name}.adf`)
if (existsSync(target)) {
  console.error(`${target} already exists — delete it first if you mean to replace it`)
  process.exit(1)
}

const readme = readmePath ? readFileSync(readmePath, 'utf-8') : undefined
const db = AdfDatabase.create(target, {
  name,
  icon: icon || undefined,
  // The README is the agent's document; seeding it through the template
  // path keeps the create code's own protections (no_delete) intact.
  ...(readme ? { template: { files: { readme } } } : {}),
})
db.close()
console.log(`created ${target}`)
