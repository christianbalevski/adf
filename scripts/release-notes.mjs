#!/usr/bin/env node
// Generate Markdown release notes from the commits between the previous
// version tag and the given tag, grouped by conventional-commit prefix.
//
// Usage: node scripts/release-notes.mjs <tag>   e.g. v0.1.3
// Prints the notes to stdout. Designed for the `publish` job in
// .github/workflows/release.yml (see RELEASING.md), but runnable locally.

import { execSync } from 'node:child_process'

const tag = process.argv[2]
if (!tag) {
  console.error('usage: node scripts/release-notes.mjs <tag>')
  process.exit(1)
}

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()
const repo =
  process.env.GITHUB_REPOSITORY ||
  sh('git config --get remote.origin.url')
    .replace(/^git@github\.com:|^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')

// Previous version tag = the vX.Y.Z tag immediately preceding `tag` by semver.
const versionTags = sh("git tag --list 'v*' --sort=-v:refname")
  .split('\n')
  .filter(Boolean)
const idx = versionTags.indexOf(tag)
const prevTag = idx >= 0 ? versionTags[idx + 1] : versionTags[0]
const range = prevTag ? `${prevTag}..${tag}` : tag

// %H<TAB>%s — hash and subject, no merge commits.
const raw = sh(`git log --no-merges --pretty=format:%H%x09%s ${range}`)
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

for (const c of commits) {
  // Skip the version-bump commit `npm version` makes (subject is the bare
  // version, e.g. "0.1.3") and explicit release chores — they're noise.
  if (/^\d+\.\d+\.\d+$/.test(c.subject)) continue
  if (/^chore\(release\):/.test(c.subject)) continue

  const m = c.subject.match(/^(\w+)(?:\([^)]+\))?!?:\s*(.+)$/)
  const short = c.hash.slice(0, 7)
  const line = `- ${m ? m[2] : c.subject} (\`${short}\`)`

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
for (const [, heading] of SECTIONS) {
  const items = buckets.get(heading)
  if (items.length) parts.push(`${heading}\n${items.join('\n')}`)
}
if (other.length) parts.push(`### 📦 Other\n${other.join('\n')}`)

if (parts.length === 0) {
  parts.push('_No notable changes._')
}

if (prevTag) {
  parts.push(
    `\n**Full changelog:** https://github.com/${repo}/compare/${prevTag}...${tag}`
  )
}

process.stdout.write(parts.join('\n\n') + '\n')
