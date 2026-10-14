import type { ComparableRecording } from './recording'

/**
 * Text form of a normalized recording, built for line diffs: one value per
 * line, object keys sorted, multi-line strings (system prompts, tool output)
 * expanded into indented blocks so a changed sentence is a one-line diff.
 */
export function renderRecording(recording: ComparableRecording): string {
  const lines: string[] = [`# parity recording: ${recording.scenario}`, '']
  lines.push('## steps')
  recording.steps.forEach((step, i) => {
    if (step.kind === 'shutdown') {
      lines.push(`${i + 1}. shutdown  [pushes ${step.pushes.before}→${step.pushes.after}]`)
      return
    }
    if (step.kind === 'wait') {
      lines.push(`${i + 1}. wait ${step.channel} — ${step.description}  [matched push ${step.pushes.matched}]`)
      return
    }
    if (step.kind === 'wait-timeout') {
      lines.push(`${i + 1}. wait ${step.channel} — ${step.description}  [TIMED OUT after push ${step.pushes.at}]`)
      return
    }
    const marks = step.kind === 'send' ? `[pushes ${step.pushes.before}]` : `[pushes ${step.pushes.before}→${step.pushes.after}]`
    lines.push(`${i + 1}. ${step.kind} ${step.channel}  ${marks}`)
    emit(lines, 'args', step.args, 1)
    if (step.kind === 'invoke') emit(lines, 'result', step.result, 1)
    if (step.kind === 'invoke-error') emit(lines, 'error', step.error, 1)
  })
  if (recording.problems?.length) {
    lines.push('', `## problems (${recording.problems.length})`, ...recording.problems)
  }
  for (const [agent, timeline] of Object.entries(recording.timelines)) {
    lines.push('', `## timeline ${agent}`, ...timeline)
  }
  for (const [channel, payloads] of Object.entries(recording.pushes)) {
    lines.push('', `## push ${channel} (${payloads.length})`)
    payloads.forEach((payload, i) => emit(lines, `#${i + 1}`, payload, 0))
  }
  lines.push('', `## local calls (${recording.local.length})`)
  recording.local.forEach((call, i) => emit(lines, `#${i + 1} ${call.api}`, call.args, 0))
  lines.push('', `## llm requests (${recording.llm.length})`)
  recording.llm.forEach((req, i) => emit(lines, `#${i + 1}`, req, 0))
  lines.push('', '## state: files')
  lines.push(...recording.state.tree)
  for (const [name, json] of Object.entries(recording.state.userDataJson)) {
    lines.push('', `## state: user-data/${name}`)
    emit(lines, name, json, 0)
  }
  for (const [file, content] of Object.entries(recording.state.leases ?? {})) {
    lines.push('', `## state: leases/${file}`)
    emit(lines, file, content, 0)
  }
  for (const [file, dump] of Object.entries(recording.state.adf)) {
    for (const [table, { columns, rows }] of Object.entries(dump.tables)) {
      lines.push('', `## state: ${file} ${table} (${rows.length} rows; ${columns.join(', ')})`)
      rows.forEach((row, i) => emit(lines, `#${i + 1}`, row, 0))
    }
  }
  return lines.join('\n') + '\n'
}

const INDENT = '  '

function scalar(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

function emit(lines: string[], label: string, value: unknown, depth: number): void {
  const pad = INDENT.repeat(depth)
  // Array items render as `- value` / `-` instead of `-: value`.
  const head = label === '-' ? `${pad}-` : `${pad}${label}:`
  if (typeof value === 'string' && value.includes('\n')) {
    lines.push(`${head} |`)
    for (const line of value.split('\n')) lines.push(`${pad}${INDENT}${JSON.stringify(line).slice(1, -1)}`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) { lines.push(`${head} []`); return }
    // `-` instead of an index: an inserted element is a one-entry diff, not a renumbering.
    lines.push(head)
    for (const item of value) emit(lines, '-', item, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    if (keys.length === 0) { lines.push(`${head} {}`); return }
    lines.push(head)
    for (const key of keys) emit(lines, key, (value as Record<string, unknown>)[key], depth + 1)
    return
  }
  lines.push(`${head} ${scalar(value)}`)
}

/**
 * Unified-style line diff of two rendered recordings ('' when equal), with
 * three lines of context. Trims the common prefix and suffix, then runs an
 * LCS over the rest; a middle too large for that is shown whole.
 */
export function diffRendered(expected: string, actual: string, labels = { expected: 'expected', actual: 'actual' }): string {
  if (expected === actual) return ''
  const a = expected.split('\n')
  const b = actual.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  type Op = { op: ' ' | '-' | '+'; line: string }
  let ops: Op[]
  if (midA.length * midB.length > 4_000_000) {
    ops = [...midA.map((line) => ({ op: '-' as const, line })), ...midB.map((line) => ({ op: '+' as const, line }))]
  } else {
    const n = midA.length
    const m = midB.length
    const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
    ops = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ op: ' ', line: midA[i] }); i++; j++ }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: '-', line: midA[i++] })
      else ops.push({ op: '+', line: midB[j++] })
    }
    while (i < n) ops.push({ op: '-', line: midA[i++] })
    while (j < m) ops.push({ op: '+', line: midB[j++] })
  }

  const CONTEXT = 3
  const out: string[] = [`--- ${labels.expected}`, `+++ ${labels.actual}`]
  const before = a.slice(Math.max(0, start - CONTEXT), start)
  const after = a.slice(endA, endA + CONTEXT)
  out.push(`@@ line ${Math.max(1, start - CONTEXT + 1)} @@`)
  for (const line of before) out.push(`  ${line}`)
  let lastPrinted = -1
  ops.forEach((o, idx) => {
    const near = ops.slice(Math.max(0, idx - CONTEXT), idx + CONTEXT + 1).some((x) => x.op !== ' ')
    if (o.op !== ' ' || near) {
      if (lastPrinted !== -1 && idx - lastPrinted > 1) out.push('  …')
      out.push(`${o.op} ${o.line}`)
      lastPrinted = idx
    }
  })
  for (const line of after) out.push(`  ${line}`)
  return out.join('\n')
}
