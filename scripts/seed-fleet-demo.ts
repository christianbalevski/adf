/**
 * Seed a demo fleet for manual verification of the fleet map (milestone 1).
 * Creates two tracked dirs with a lineage tree: commander → scout, builder.
 * Usage: npx tsx scripts/seed-fleet-demo.ts <target-dir>
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import { AdfDatabase } from '../src/main/adf/adf-database'

const target = process.argv[2]
if (!target) {
  console.error('usage: npx tsx scripts/seed-fleet-demo.ts <target-dir>')
  process.exit(1)
}

const squadDir = join(target, 'squad')
const opsDir = join(target, 'ops')
mkdirSync(squadDir, { recursive: true })
mkdirSync(opsDir, { recursive: true })

const commander = AdfDatabase.create(join(squadDir, 'commander.adf'), {
  name: 'Commander',
  icon: '🎖️',
  instructions: 'Fleet demo agent. Do nothing.'
})
const commanderId = commander.getConfig()!.id
commander.setMeta('status', 'coordinating the squad')
commander.close()

for (const [name, icon, status] of [
  ['Scout', '🔭', 'surveying'],
  ['Builder', '🔨', 'awaiting orders']
] as const) {
  const db = AdfDatabase.create(join(squadDir, `${name.toLowerCase()}.adf`), {
    name,
    icon,
    instructions: 'Fleet demo agent. Do nothing.'
  })
  // Legacy config.id parent reference — exercises the D4 cascade's third level
  db.setMeta('adf_parent_did', commanderId)
  db.setMeta('status', status)
  db.close()
}

const watcher = AdfDatabase.create(join(opsDir, 'watcher.adf'), {
  name: 'Watcher',
  icon: '👁️',
  instructions: 'Fleet demo agent. Do nothing.'
})
watcher.setMeta('status', 'standing by')
watcher.close()

console.log(`Seeded fleet demo: ${squadDir} (commander + scout + builder), ${opsDir} (watcher)`)
console.log(`commander config.id = ${commanderId}`)
