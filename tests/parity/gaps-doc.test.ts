import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { renderGapTable } from './harness/gaps'

/**
 * docs/design/daemon-backend-gaps.md "Parity diffs after W2-C" is the table
 * of harness/gaps.ts, generated: the list is the source of truth.
 * PARITY_WRITE_GAPS_DOC=1 rewrites the section.
 */
const DOC = join(__dirname, '..', '..', 'docs', 'design', 'daemon-backend-gaps.md')
const START = '<!-- gap-allowlist:start -->'
const END = '<!-- gap-allowlist:end -->'

it('the gaps doc lists exactly the parity gap allowlist', () => {
  const doc = readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n')
  const a = doc.indexOf(START)
  const b = doc.indexOf(END)
  expect(a >= 0 && b > a, `${DOC} needs the ${START} / ${END} markers`).toBe(true)
  const want = `${START}\n${renderGapTable()}\n${END}`
  const have = doc.slice(a, b + END.length)
  if (process.env.PARITY_WRITE_GAPS_DOC === '1' && have !== want) {
    writeFileSync(DOC, doc.slice(0, a) + want + doc.slice(b + END.length))
    return
  }
  expect(have).toBe(want)
})
