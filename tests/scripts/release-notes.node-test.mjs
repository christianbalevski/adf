import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../../scripts/release-notes.mjs', import.meta.url))

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'adf-release-notes-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const env = { ...process.env, GITHUB_REPOSITORY: 'example/adf', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'Release notes test')
  git('config', 'user.email', 'release-notes@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('commit', '--allow-empty', '-m', 'chore: initial')
  git('tag', 'v1.0.0')
  for (const subject of [
    'feat: answer several questions',
    'fix: open remote website',
    'feat(api)!: replace old endpoint',
    'docs: clarify install',
    'Uncategorized change',
    'chore(release): prepare version',
    '1.0.1',
  ]) git('commit', '--allow-empty', '-m', subject)
  git('tag', 'v1.0.1')
  mkdirSync(join(cwd, 'docs', 'release-notes'), { recursive: true })
  const opening = (tag, text) => writeFileSync(join(cwd, 'docs', 'release-notes', `${tag}.md`), text)
  const generate = (tag = 'v1.0.1') => execFileSync(process.execPath, [script, tag], {
    cwd, env, encoding: 'utf8', windowsHide: true,
  })
  return { cwd, env, git, opening, generate }
}

function assertChangelog(notes) {
  assert.match(notes, /### ⚠️ Breaking changes\n- replace old endpoint/)
  assert.match(notes, /### 🚀 Features\n- answer several questions/)
  assert.match(notes, /### 🐛 Fixes\n- open remote website/)
  assert.match(notes, /### 📝 Docs\n- clarify install/)
  assert.match(notes, /### 📦 Other\n- Uncategorized change/)
  assert.doesNotMatch(notes, /prepare version|^- 1\.0\.1/m)
  assert.match(notes, /https:\/\/github.com\/example\/adf\/compare\/v1\.0\.0\.\.\.v1\.0\.1/)
  assert.match(notes, /Official release installers are signed by Christian Balevski\./)
  assert.doesNotMatch(notes, /unsigned installer|Run anyway|no warnings/)
  assert.match(notes, /sudo apt install \.\/adf-studio_\*_amd64\.deb/)
}

test('exact-version opening precedes the unchanged commit groups and install footer', (t) => {
  const f = fixture(t)
  f.opening('v1.0.1', '\nYou can now answer several questions together.\n\nUpgrade caveat.\n')
  const notes = f.generate()
  assert.ok(notes.startsWith('You can now answer several questions together.\n\nUpgrade caveat.\n\n### ⚠️ Breaking changes'))
  assert.equal(notes.split('You can now answer several questions together.').length - 1, 1)
  assertChangelog(notes)
})

test('an opening for another version is never reused', (t) => {
  const f = fixture(t)
  f.opening('v1.0.0', 'Wrong older release opening.')
  f.opening('v1.0.2', 'Wrong upcoming release opening.')
  const notes = f.generate()
  assert.ok(notes.startsWith('### ⚠️ Breaking changes'))
  assert.doesNotMatch(notes, /Wrong/)
  assertChangelog(notes)
})

test('missing or empty opening retains generated notes without a new gate', (t) => {
  const f = fixture(t)
  const missing = f.generate()
  f.opening('v1.0.1', ' \n\n')
  assert.equal(f.generate(), missing)
  assertChangelog(missing)
})

test('an opening does not suppress the no-notable-changes fallback', (t) => {
  const f = fixture(t)
  f.git('commit', '--allow-empty', '-m', '1.0.2')
  f.git('tag', 'v1.0.2')
  f.opening('v1.0.2', 'Maintenance release.')
  assert.ok(f.generate('v1.0.2').startsWith('Maintenance release.\n\n_No notable changes._'))
})

test('rejects paths, options, and shell expressions as release tags', (t) => {
  const f = fixture(t)
  for (const tag of ['../v1.0.1', '--all', 'v1.0.1; echo injected', 'v1.0.1$(echo injected)']) {
    const result = spawnSync(process.execPath, [script, tag], {
      cwd: f.cwd, env: f.env, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /release tag must have the form/)
    assert.equal(result.stdout, '')
  }
})
