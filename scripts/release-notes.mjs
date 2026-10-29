#!/usr/bin/env node
// Generate Markdown release notes from the commits between the previous
// version tag and the given tag, grouped by conventional-commit prefix,
// with an optional reviewed opening from docs/release-notes/<tag>.md.
//
// Usage: node scripts/release-notes.mjs <tag>   e.g. v0.1.3
// Prints the notes to stdout. Designed for the `publish` job in
// .github/workflows/release.yml (see RELEASING.md), but runnable locally.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tag = process.argv[2]
if (!tag) {
  console.error('usage: node scripts/release-notes.mjs <tag>')
  process.exit(1)
}
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error('release tag must have the form vX.Y.Z (optional prerelease/build suffix)')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
const repo =
  process.env.GITHUB_REPOSITORY ||
  git('config', '--get', 'remote.origin.url')
    .replace(/^git@github\.com:|^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')

// Previous version tag = the vX.Y.Z tag immediately preceding `tag` by semver.
const versionTags = git('tag', '--list', 'v*', '--sort=-v:refname')
  .split('\n')
  .filter(Boolean)
const idx = versionTags.indexOf(tag)
const prevTag = idx >= 0 ? versionTags[idx + 1] : versionTags[0]
const range = prevTag ? `${prevTag}..${tag}` : tag

// %H<TAB>%s — hash and subject, no merge commits.
const raw = git('log', '--no-merges', '--pretty=format:%H%x09%s', '--end-of-options', range, '--')
const commits = raw
  ? raw.split('\n').map((l) => {
      const [hash, ...rest] = l.split('\t')
      return { hash, subject: rest.join('\t') }
    })
  : []

// type -> section heading. Anything unmatched falls under "Other".
const SECTIONS = [
  ['feat', '### 🚀 Features'],
  ['fix', '### 🐛 Fixes'],
  ['perf', '### ⚡ Performance'],
  ['refactor', '### ♻️ Refactors'],
  ['docs', '### 📝 Docs'],
  ['ci|build', '### 👷 CI / Build'],
  ['test', '### ✅ Tests'],
  ['chore', '### 🧹 Chores'],
]

const buckets = new Map(SECTIONS.map(([, h]) => [h, []]))
const other = []
// `type!:` / `type(scope)!:` (Conventional Commits breaking marker) is listed
// under its own heading first, instead of under its type.
const breaking = []

for (const c of commits) {
  // Skip the version-bump commit `npm version` makes (subject is the bare
  // version, e.g. "0.1.3") and explicit release chores — they're noise.
  if (/^\d+\.\d+\.\d+$/.test(c.subject)) continue
  if (/^chore\(release\):/.test(c.subject)) continue

  const m = c.subject.match(/^(\w+)(?:\([^)]+\))?(!)?:\s*(.+)$/)
  const short = c.hash.slice(0, 7)
  const line = `- ${m ? m[3] : c.subject} (\`${short}\`)`

  if (m?.[2]) {
    breaking.push(line)
    continue
  }
  if (m) {
    const section = SECTIONS.find(([types]) =>
      types.split('|').includes(m[1].toLowerCase())
    )
    if (section) {
      buckets.get(section[1]).push(line)
      continue
    }
  }
  other.push(line)
}

const parts = []
if (breaking.length) parts.push(`### ⚠️ Breaking changes\n${breaking.join('\n')}`)
for (const [, heading] of SECTIONS) {
  const items = buckets.get(heading)
  if (items.length) parts.push(`${heading}\n${items.join('\n')}`)
}
if (other.length) parts.push(`### 📦 Other\n${other.join('\n')}`)

if (parts.length === 0) {
  parts.push('_No notable changes._')
}

// A reviewed opening belongs to one exact version. Missing files keep the
// existing generated changelog; they do not introduce a release gate.
const openingPath = join(git('rev-parse', '--show-toplevel'), 'docs', 'release-notes', `${tag}.md`)
try {
  const opening = readFileSync(openingPath, 'utf8').trim()
  if (opening) parts.unshift(opening)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

if (prevTag) {
  parts.push(
    `\n**Full changelog:** https://github.com/${repo}/compare/${prevTag}...${tag}`
  )
}

// Install copy follows the tagged-release workflow's signing configuration.
// A signature does not guarantee that the operating system shows no warning.
parts.push(
  [
    '---',
    '### 📥 Install',
    '',
    '**macOS** (`.dmg`) — pick `-arm64` for Apple Silicon, `-universal` for Intel.',
    'Signed and notarized: drag to Applications and open.',
    '',
    '**Windows** (`.exe`) — open the installer and follow the setup prompts.',
    'Official release installers are signed by Christian Balevski.',
    '',
    '**Linux** — prefer the `.deb` (note: lowercase name, underscores):',
    '`sudo apt install ./adf-studio_*_amd64.deb`',
    'For the `.AppImage`: `chmod +x ADF-Studio-*.AppImage && ./ADF-Studio-*.AppImage`',
    '(needs `libfuse2`: `sudo apt install libfuse2`).',
    '',
    'Already installed? Newer releases show an **Update** badge next to the version number in the status bar.',
  ].join('\n')
)

process.stdout.write(parts.join('\n\n') + '\n')
