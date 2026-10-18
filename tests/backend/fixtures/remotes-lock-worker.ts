/**
 * One contender for cli-remotes.json.lock (tests/backend/remotes-lock.test.ts):
 * `node --import tsx remotes-lock-worker.ts <dir> <id> <rounds>`. Inside each
 * change it holds `<dir>/holder` exclusively; a second holder at the same
 * time is written to `<dir>/violations`. Worker 0 also leaves a stale lock
 * behind after each change, as a holder that died would.
 */
import { appendFile, open, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { updateRemotes } from '../../../src/main/cli/remotes'

const [dir, id, rounds] = process.argv.slice(2)
const env = { ...process.env, ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json') }
const holder = join(dir, 'holder')

async function main(): Promise<void> {
  for (let i = 0; i < Number(rounds); i++) {
    await updateRemotes(env, async (file) => {
      let mine = false
      try {
        await (await open(holder, 'wx')).close()
        mine = true
      } catch {
        await appendFile(join(dir, 'violations'), `${id}\n`)
      }
      await new Promise((r) => setTimeout(r, 30))
      file.remotes[`w${id}-${i}`] = { url: 'https://hub.example.com', fingerprint: `W${id}-${i}`, deviceId: '', label: '', pairedAt: '' }
      if (mine) await unlink(holder)
    }, { waitMs: 60_000 })
    // Worker 0 also plays a holder that dies: it leaves a stale lock behind, so the others contend on a takeover again.
    if (id === '0' && i < Number(rounds) - 1) {
      try {
        await (await open(`${env.ADF_DAEMON_SETTINGS.replace(/adf-settings\.json$/, 'cli-remotes.json')}.lock`, 'wx')).close()
        const old = new Date(Date.now() - 60_000)
        await utimes(`${env.ADF_DAEMON_SETTINGS.replace(/adf-settings\.json$/, 'cli-remotes.json')}.lock`, old, old)
      } catch { /* someone holds it now */ }
      await new Promise((r) => setTimeout(r, 40))
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
