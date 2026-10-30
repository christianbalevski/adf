import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const code = readFileSync(new URL('../scripts/docs-search.js', import.meta.url), 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const O = m.ORIGIN;

// Fake adf proxy over an in-memory repository. Any tool other than sys_fetch
// fails the test, so the helper provably never writes or reconfigures.
// A file value may be a string (200), { status } or { throws }.
function installRepo(files) {
  const calls = [];
  const handlers = {
    sys_fetch: async input => {
      calls.push(input.url);
      assert.ok(input.url.startsWith(O), `off-origin request ${input.url}`);
      const f = files[input.url.slice(O.length)];
      if (f === undefined) return {status: 404, statusText: 'Not Found', headers: {}, body: '404: Not Found'};
      if (typeof f === 'object' && f.throws) throw new Error(f.throws);
      if (typeof f === 'object') return {status: f.status, statusText: '', headers: {}, body: f.body ?? ''};
      return {status: 200, statusText: 'OK', headers: {}, body: f};
    }
  };
  globalThis.adf = new Proxy({}, {get: (_, name) => handlers[name] ?? (() => { throw new Error(`unexpected tool ${String(name)}`); })});
  return calls;
}

const GUIDES = `---
type: index
---

# ADF Feature Guides

Every guide is fetchable at \`https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/<name>.md\`.

## Execution & Automation

- **timers.md** — one-time, recurring, and cron-based scheduling
- **triggers.md** — events that wake the agent (on_inbox, on_timer, etc.)
- **authorized-code.md** — privileged code, HIL approval, and restricted tools
- **../../registry/README.md** — the agent files the app ships in its registry

## Knowledge Base

- **../knowledge/index.md** — consultable task references
- **../knowledge/desktop-apps.md** — visible Linux GUI processes in isolated compute
`;

const KB = `---
type: index
---

# Knowledge Base

- **Feature guides** describe supported feature contracts, timers included.
- **[Skills](../guides/skills.md)** own the canonical executable agent workflow.

Prose links such as [the catalog](../../skills/README.md) about timers are not entries.

## Articles

- [Gmail setup](gmail-setup.md#oauth) — Direct Gmail connection and OAuth.
- [Desktop applications](desktop-apps.md) — Run a Linux GUI app in isolated compute.
- [Evil](https://evil.example/x.md) — timer exfiltration
- [Escape](../../../etc/passwd.md) — timer escape
- [Encoded](..%2F..%2Fsecret.md) — timer encoded
- [Data](../../skills/registry.json) — timer catalog
`;

const REGISTRY = JSON.stringify({
  schema: 1,
  skills: [
    {name: 'gmail-setup', description: 'Connect Gmail through MCP and review tool permissions.', path: 'skills/gmail-setup/SKILL.md', raw_url: 'https://evil.example/gmail.md'},
    {name: 'goal-seeking', description: 'Coordinate loops, peers and timers.', path: 'skills/goal-seeking/SKILL.md',
      files: [{path: 'agents/openai.yaml'}, {path: '../escape.js'}, {path: '/abs.js'}]},
    {name: 'sneaky', description: 'timer', path: 'skills/other/SKILL.md'},
    {name: 'Bad Name', description: 'timer', path: 'skills/Bad Name/SKILL.md'}
  ]
});

const repo = (extra = {}) => ({
  'docs/guides/index.md': GUIDES,
  'docs/knowledge/index.md': KB,
  'skills/registry.json': REGISTRY,
  'docs/guides/timers.md': '# Timers\nRecurring timers.\n',
  'docs/guides/triggers.md': '# Triggers\n',
  'docs/guides/authorized-code.md': '# Authorized code\n',
  'docs/knowledge/gmail-setup.md': '# Gmail\n',
  'skills/gmail-setup/SKILL.md': '---\nname: gmail-setup\n---\n',
  'skills/goal-seeking/SKILL.md': '# Goal\n',
  ...extra
});

const indexUrls = m.INDEXES.map(ix => O + ix.path);

test('paths: relative resolution, fragments dropped, unsafe references rejected', () => {
  assert.deepEqual(m.resolveRepoPath('docs/guides', '../../registry/README.md'), {path: 'registry/README.md'});
  assert.deepEqual(m.resolveRepoPath('docs/guides', '../knowledge/gmail-setup.md'), {path: 'docs/knowledge/gmail-setup.md'});
  assert.deepEqual(m.resolveRepoPath('docs/knowledge', './gmail-setup.md#oauth'), {path: 'docs/knowledge/gmail-setup.md'});
  for (const [ref, reason] of [
    ['https://evil.example/a.md', 'absolute URL'], ['//evil.example/a.md', 'absolute URL'], ['javascript:alert(1).md', 'absolute URL'],
    ['/etc/a.md', 'absolute path'], ['../../../a.md', 'escapes repository root'], ['a.md?x=1', 'query string'],
    ['..%2Fa.md', 'percent-encoded path'], ['a\\b.md', 'backslash'], ['a b.md', 'unsupported characters'],
    ['x.json', 'not a markdown document'], ['a‮.md', 'control or bidi character']
  ]) assert.deepEqual(m.resolveRepoPath('docs/guides', ref), {error: reason}, ref);
});

test('parsing: guide bold filenames and KB list links are entries; prose and bold prose are not', () => {
  const g = m.parseMarkdownIndex(GUIDES, 'docs/guides/index.md');
  assert.deepEqual(g.entries.map(e => e.path), [
    'docs/guides/timers.md', 'docs/guides/triggers.md', 'docs/guides/authorized-code.md',
    'registry/README.md', 'docs/knowledge/index.md', 'docs/knowledge/desktop-apps.md'
  ]);
  assert.equal(g.entries[0].section, 'Execution & Automation');
  assert.equal(g.entries[0].description, 'one-time, recurring, and cron-based scheduling');
  const k = m.parseMarkdownIndex(KB, 'docs/knowledge/index.md');
  assert.deepEqual(k.entries.map(e => [e.path, e.title]), [
    ['docs/knowledge/gmail-setup.md', 'Gmail setup'], ['docs/knowledge/desktop-apps.md', 'Desktop applications']
  ]);
  assert.deepEqual(k.rejected.map(r => r.reason), ['absolute URL', 'escapes repository root', 'percent-encoded path', 'not a markdown document']);
});

test('parsing: registry paths validated, raw_url ignored, package files confined', () => {
  const r = m.parseRegistry(REGISTRY, 'skills/registry.json');
  assert.deepEqual(r.entries.map(e => e.path), ['skills/gmail-setup/SKILL.md', 'skills/goal-seeking/SKILL.md']);
  assert.deepEqual(r.entries[1].skill.files, [{path: 'agents/openai.yaml', raw_url: O + 'skills/goal-seeking/agents/openai.yaml'}]);
  assert.deepEqual(r.rejected.map(x => x.reason), ['path is not skills/<name>/SKILL.md', 'invalid skill name']);
  assert.throws(() => m.parseRegistry('{', 'skills/registry.json'), /invalid JSON/);
  assert.throws(() => m.parseRegistry('{"skills":{}}', 'skills/registry.json'), /no skills array/);
});

test('search: exactly three index requests, at most three documents, all on the fixed origin', async () => {
  const calls = installRepo(repo());
  const r = await m.main({query: 'timer', fetch_top: 99, limit: 99});
  assert.deepEqual(calls.slice(0, 3).sort(), [...indexUrls].sort());
  assert.equal(r.requests.index, 3);
  assert.ok(r.requests.documents <= 3);
  assert.equal(calls.length, 3 + r.requests.documents);
  assert.equal(r.requests.total, calls.length);
  assert.ok(calls.every(u => u.startsWith(O)));
  assert.ok(!calls.some(u => u.includes('evil') || u.includes('passwd') || u.includes('registry.json') && u !== O + 'skills/registry.json'));
  assert.equal(r.hits[0].path, 'docs/guides/timers.md');
  assert.ok(r.hits[0].document.ok);
  assert.match(r.hits[0].reason, /"timer".*path: timer.*docs\/guides\/index\.md › Execution & Automation/);
  // Hits beyond fetch_top carry no document.
  assert.ok(r.hits.slice(3).every(h => h.document === undefined));
});

test('search: deduplicates by normalized path across indexes and keeps both sources', async () => {
  installRepo(repo());
  const r = await m.main({query: 'linux gui', fetch_top: 0});
  assert.deepEqual(r.hits.map(h => h.path), ['docs/knowledge/desktop-apps.md']);
  assert.deepEqual(r.hits[0].sources, ['docs/guides/index.md', 'docs/knowledge/index.md']);
});

test('search: registry skills rank, carry confined resources and the derived raw URL', async () => {
  installRepo(repo());
  const r = await m.main({query: 'gmail setup', fetch_top: 3});
  assert.deepEqual(r.hits.map(h => h.path).sort(), ['docs/knowledge/gmail-setup.md', 'skills/gmail-setup/SKILL.md']);
  const skill = r.hits.find(h => h.skill);
  assert.equal(skill.skill.name, 'gmail-setup');
  assert.equal(skill.raw_url, O + 'skills/gmail-setup/SKILL.md');
});

test('search: zero-score is an honest no-hit with no document fetches', async () => {
  const calls = installRepo(repo());
  const r = await m.main({query: 'kubernetes'});
  assert.equal(r.ok, true);
  assert.equal(r.no_hit, true);
  assert.deepEqual(r.hits, []);
  assert.equal(calls.length, 3);
  assert.equal(r.requests.documents, 0);
});

test('search: ties are stable and ordered by path', async () => {
  const guides = '## A\n\n- **mid.md** — alpha\n- **abc.md** — alpha\n- **zed.md** — alpha\n';
  installRepo(repo({'docs/guides/index.md': guides, 'docs/knowledge/index.md': '# KB\n', 'skills/registry.json': '{"skills":[]}'}));
  const r = await m.main({query: 'alpha', fetch_top: 0});
  assert.deepEqual(r.hits.map(h => h.path), ['docs/guides/abc.md', 'docs/guides/mid.md', 'docs/guides/zed.md']);
  assert.ok(r.hits.every(h => h.score === r.hits[0].score));
});

test('search: function words alone never score', async () => {
  installRepo(repo());
  await assert.rejects(m.main({query: 'how do I do it with my'}), /no searchable terms/);
});

test('errors: partial index failure is surfaced; total failure is not ok', async () => {
  installRepo(repo({'docs/knowledge/index.md': {status: 500}, 'skills/registry.json': 'not json'}));
  const r = await m.main({query: 'timer', fetch_top: 0});
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  const byPath = Object.fromEntries(r.indexes.map(i => [i.path, i]));
  assert.equal(byPath['docs/knowledge/index.md'].error, 'HTTP 500');
  assert.match(byPath['skills/registry.json'].error, /^parse error: invalid JSON/);
  assert.match(r.notes[0], /Indexes unavailable/);
  assert.equal(r.hits[0].path, 'docs/guides/timers.md');

  installRepo({'docs/guides/index.md': {throws: 'Request timed out after 15000ms'}});
  const none = await m.main({query: 'timer'});
  assert.equal(none.ok, false);
  assert.deepEqual(none.hits, []);
  assert.equal(none.indexes[0].error, 'Request timed out after 15000ms');
});

test('errors: a failed document fetch is reported on the hit', async () => {
  const files = repo();
  delete files['docs/guides/timers.md'];
  installRepo(files);
  const r = await m.main({query: 'recurring timers', fetch_top: 1});
  assert.equal(r.hits[0].path, 'docs/guides/timers.md');
  assert.deepEqual(r.hits[0].document, {ok: false, error: 'HTTP 404 Not Found', status: 404});
  assert.match(r.notes.join(' '), /could not be fetched/);
});

test('truncation: document text is bounded and marked', async () => {
  installRepo(repo({'docs/guides/timers.md': 'x'.repeat(5000)}));
  const r = await m.main({query: 'recurring', fetch_top: 1, max_chars: 100});
  const d = r.hits[0].document;
  assert.equal(d.truncated, true);
  assert.equal(d.total_chars, 5000);
  assert.ok(d.text.startsWith('x'.repeat(100) + '\n\n[truncated: showing first 100 of 5000'));
});

test('args: strict validation and clamping', async () => {
  installRepo(repo());
  for (const args of [{}, {query: ''}, {query: 'x'.repeat(501)}, {query: 'timer', limit: 0}, {query: 'timer', fetch_top: -1},
    {query: 'timer', max_chars: 1.5}, {query: 'timer', timeout_ms: '5'}, {query: 'timer', url: 'https://evil.example/'}]) {
    await assert.rejects(m.main(args), Error);
  }
  assert.deepEqual(m.validateArgs({query: ' timer ', fetch_top: 10, limit: 1000, max_chars: 1e9, timeout_ms: 1e9}),
    {query: 'timer', fetch_top: 3, limit: 20, max_chars: 40000, timeout_ms: 30000});
});

test('tokens: light suffix folding only, no synonyms', () => {
  assert.deepEqual(m.tokenize('Timers recurring policies'), ['timer', 'recurr', 'policy']);
  assert.deepEqual(m.tokenize('the secret'), ['secret']);
  assert.notDeepEqual(m.tokenize('secret'), m.tokenize('credential'));
});
