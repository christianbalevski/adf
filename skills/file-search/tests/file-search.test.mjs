import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const code = readFileSync(new URL('../scripts/file-search.js', import.meta.url), 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

// In-memory VFS behind a fake adf proxy. Any tool other than fs_list/fs_read
// fails the test, so the skill provably never writes or reconfigures.
// `read_content` / `read_mime_type` simulate a write between fs_list and fs_read.
function installVfs(files, {listAsTruncatedString = false} = {}) {
  const calls = [];
  const byPath = new Map(files.map(f => [f.path, f]));
  const handlers = {
    fs_list: async input => {
      calls.push({tool: 'fs_list', input});
      const rows = files
        .filter(f => !input.prefix || f.path.startsWith(input.prefix))
        .map(f => ({path: f.path, size: f.size ?? Buffer.byteLength(f.content ?? ''), mime_type: 'mime_type' in f ? f.mime_type : 'text/plain'}));
      return listAsTruncatedString ? `${JSON.stringify(rows.slice(0, 1))}\n\n--- TRUNCATED at 1 files (${rows.length} match) ---` : rows;
    },
    fs_read: async input => {
      calls.push({tool: 'fs_read', input});
      const f = byPath.get(input.path);
      if (!f || f.fail) throw new Error(`File not found: "${input.path}"`);
      const content = f.read_content ?? f.content;
      const mime = 'read_mime_type' in f ? f.read_mime_type : 'mime_type' in f ? f.mime_type : 'text/plain';
      return {path: f.path, content, mime_type: mime, size: 'read_content' in f ? Buffer.byteLength(content) : f.size};
    }
  };
  globalThis.adf = new Proxy({}, {get: (_, name) => handlers[name] ?? (() => { throw new Error(`unexpected tool ${String(name)}`); })});
  return calls;
}

const stripTiming = r => ({...r, coverage: {...r.coverage, elapsed_ms: 0}});

test('exact: case-insensitive literal, 1-indexed line/column aligned with fs_read lines, CRLF safe', async () => {
  installVfs([
    {path: 'notes/a.md', content: 'intro\r\nThe Quick fox\r\nquick again (a+b)'},
    {path: 'notes/b.md', content: 'nothing here'}
  ]);
  const r = await m.main({query: 'quick'});
  assert.equal(r.mode, 'exact');
  assert.deepEqual(r.results.map(x => x.path), ['notes/a.md']);
  assert.deepEqual(r.results[0].matches, [
    {line: 2, column: 5, snippet: 'The Quick fox'},
    {line: 3, column: 1, snippet: 'quick again (a+b)'}
  ]);
  // Regex metacharacters are literal in exact mode.
  const lit = await m.main({query: '(a+b)'});
  assert.equal(lit.results[0].matches[0].column, 13);
  const cs = await m.main({query: 'Quick', case_sensitive: true});
  assert.equal(cs.results[0].match_count, 1);
});

test('exact: deterministic ordering by score desc then path asc, independent of listing order', async () => {
  installVfs([
    {path: 'z.txt', content: 'term\nterm'},
    {path: 'b.txt', content: 'term'},
    {path: 'a.txt', content: 'term'},
    {path: 'y.txt', content: 'term\nterm'}
  ]);
  const first = await m.main({query: 'term'});
  assert.deepEqual(first.results.map(x => [x.path, x.score]), [['y.txt', 2], ['z.txt', 2], ['a.txt', 1], ['b.txt', 1]]);
  const second = await m.main({query: 'term'});
  assert.deepEqual(stripTiming(second), stripTiming(first));
  const byPath = await m.main({query: 'term', ranking: {sort: 'path'}});
  assert.deepEqual(byPath.results.map(x => x.path), ['a.txt', 'b.txt', 'y.txt', 'z.txt']);
});

test('bm25Scores matches a hand-computed Okapi BM25 value', () => {
  const docs = [
    {tf: new Map([['cat', 2]]), length: 2},
    {tf: new Map([['dog', 1]]), length: 4},
    {tf: new Map(), length: 6}
  ];
  const [s0, s1, s2] = m.bm25Scores(docs, new Set(['cat']), {k1: 1.2, b: 0.75});
  const idf = Math.log(1 + (3 - 1 + 0.5) / (1 + 0.5));
  // avg length = 4, so this document's length factor is 2/4.
  const expected = idf * (2 * 2.2) / (2 + 1.2 * (1 - 0.75 + 0.75 * 2 / 4));
  assert.ok(Math.abs(s0 - expected) < 1e-12, `${s0} != ${expected}`);
  assert.equal(s1, 0);
  assert.equal(s2, 0);
  // Same tf, longer document scores lower unless b = 0.
  const pair = [{tf: new Map([['cat', 1]]), length: 2}, {tf: new Map([['cat', 1]]), length: 20}];
  const [short, long] = m.bm25Scores(pair, new Set(['cat']), {k1: 1.2, b: 0.75});
  assert.ok(short > long);
  const [flatA, flatB] = m.bm25Scores(pair, new Set(['cat']), {k1: 1.2, b: 0});
  assert.equal(flatA, flatB);
});

test('bm25: rare terms outrank common ones, length normalization applies, snippets carry locations', async () => {
  installVfs([
    {path: 'docs/common.md', content: 'deploy deploy deploy\nnotes'},
    {path: 'docs/rare.md', content: 'deploy steps\nrollback procedure for deploy'},
    {path: 'docs/other.md', content: 'deploy once'},
    {path: 'docs/long.md', content: 'rollback ' + 'filler '.repeat(400)}
  ]);
  const r = await m.main({query: 'rollback deploy', mode: 'bm25', ranking: {path_weight: 0}});
  assert.equal(r.results[0].path, 'docs/rare.md');
  // Same single rollback hit, but the long file is length-penalised below rare.md.
  const long = r.results.find(x => x.path === 'docs/long.md');
  assert.ok(long.score < r.results[0].score);
  // Line with both terms comes first, column points at the first query token.
  assert.deepEqual(r.results[0].matches[0], {line: 2, column: 1, snippet: 'rollback procedure for deploy'});
  assert.equal(r.results[0].match_count, 2);
  assert.ok(r.notes.some(n => n.includes('scanned files only')));
});

test('bm25: path tokens contribute via path_weight; prefix boosts reorder; ranking contract is data-only', async () => {
  installVfs([
    {path: 'a/budget.md', content: 'plan'},
    {path: 'b/notes.md', content: 'budget plan'}
  ]);
  const noPath = await m.main({query: 'budget', mode: 'bm25', ranking: {path_weight: 0}});
  assert.deepEqual(noPath.results.map(x => x.path), ['b/notes.md']);
  const withPath = await m.main({query: 'budget', mode: 'bm25', ranking: {path_weight: 2}});
  assert.equal(withPath.results[0].path, 'a/budget.md');
  assert.deepEqual(withPath.results[0].matches, []);
  const boosted = await m.main({query: 'budget', mode: 'bm25', ranking: {path_weight: 2, boosts: [{prefix: 'b/', weight: 10}]}});
  assert.equal(boosted.results[0].path, 'b/notes.md');
  const excluded = await m.main({query: 'budget', mode: 'bm25', ranking: {boosts: [{prefix: 'b/', weight: 0}]}});
  assert.ok(!excluded.results.some(x => x.path.startsWith('b/')));
  for (const ranking of [{scorer: () => 1}, {k1: 9}, {b: -1}, {sort: 'random'}, {boosts: [{prefix: 1}]}, [],
    {boosts: [() => 1]}, {boosts: [['b/', 2]]}, {boosts: [{prefix: 'b/', weight: () => 2}]}]) {
    await assert.rejects(m.main({query: 'budget', mode: 'bm25', ranking}));
  }
});

test('ranking: unknown nested boost keys are rejected like unknown top-level keys, functions included', async () => {
  installVfs([{path: 'b/notes.md', content: 'budget'}]);
  await assert.rejects(m.main({query: 'budget', ranking: {scorer: () => 1}}), /Unknown ranking key "scorer"/);
  await assert.rejects(m.main({query: 'budget', ranking: {boosts: [{prefix: 'b/', weight: 2, scorer: () => 1}]}}),
    /Unknown ranking\.boosts\[0\] key "scorer"/);
  await assert.rejects(m.main({query: 'budget', mode: 'bm25', ranking: {boosts: [{prefix: 'a/', weight: 1}, {prefix: 'b/', weight: 2, extra: 1}]}}),
    /Unknown ranking\.boosts\[1\] key "extra"/);
  // Exactly { prefix, weight } (weight optional) is still accepted.
  const ok = await m.main({query: 'budget', ranking: {boosts: [{prefix: 'b/', weight: 2}, {prefix: 'c/'}]}});
  assert.equal(ok.results[0].score, 2);
});

test('regex: matches with locations; invalid, empty-matching and unsafe patterns are rejected', async () => {
  installVfs([{path: 'src/app.js', content: 'const a = 1;\nfunction fooBar() {}\nlet TODO_42 = x;'}]);
  const r = await m.main({query: 'TODO_\\d+', mode: 'regex'});
  assert.deepEqual(r.results[0].matches, [{line: 3, column: 5, snippet: 'let TODO_42 = x;'}]);
  await assert.rejects(m.main({query: '(', mode: 'regex'}), /Invalid regex/);
  await assert.rejects(m.main({query: 'x*', mode: 'regex'}), /empty string/);
  for (const bad of ['(a+)+$', '(\\w*)*x', '(a|aa)+b', '(a)\\1']) {
    await assert.rejects(m.main({query: bad, mode: 'regex'}), /Regex rejected/, bad);
  }
  // Explicit opt-in compiles it (this input is tiny, so it terminates).
  const unsafe = await m.main({query: '(o+)+B', mode: 'regex', allow_unsafe_regex: true});
  assert.equal(unsafe.results[0].matches[0].line, 2);
  assert.equal(m.unsafeRegexReason('^[a-z]+\\.md$'), null);
});

test('regex: very long lines are capped and reported, so coverage is not claimed complete', async () => {
  installVfs([{path: 'big.txt', content: 'x'.repeat(5000) + 'NEEDLE'}]);
  const r = await m.main({query: 'NEEDLE', mode: 'regex'});
  assert.equal(r.results.length, 0);
  assert.equal(r.coverage.long_lines_truncated, 1);
  assert.equal(r.coverage.complete, false);
  // Exact mode scans the whole line.
  assert.equal((await m.main({query: 'NEEDLE'})).results.length, 1);
});

test('binary, oversized and unreadable files are skipped explicitly; oversized files are never read', async () => {
  const calls = installVfs([
    {path: 'img.png', content: 'iVBORw0KGgo=', mime_type: 'image/png'},
    {path: 'blob', content: 'AAAA', mime_type: null},
    {path: 'nul.txt', content: 'needle\u0000junk'},
    {path: 'huge.log', content: 'needle', size: 10 * 1024 * 1024},
    {path: 'gone.md', content: 'needle', fail: true},
    {path: 'ok.json', content: '{"k":"needle"}', mime_type: 'application/json'}
  ]);
  const r = await m.main({query: 'needle'});
  assert.deepEqual(r.results.map(x => x.path), ['ok.json']);
  assert.deepEqual(r.coverage.skipped, {binary: 3, too_large: 1, read_error: 1, over_file_cap: 0, over_byte_budget: 0, over_time_budget: 0});
  assert.equal(r.coverage.complete, false);
  assert.ok(!calls.some(c => c.tool === 'fs_read' && ['huge.log', 'img.png', 'blob'].includes(c.input.path)));
  assert.ok(r.coverage.skipped_examples.some(x => x.path === 'huge.log' && x.reason === 'too_large'));
  assert.ok(r.notes.some(n => n.includes('start_line/end_line')));
});

test('stale fs_list size: caps and byte accounting use the UTF-8 length fs_read returned', async () => {
  // Listed at 1 byte, but 300 'é' are 600 UTF-8 bytes (300 UTF-16 units) by read time.
  const grown = 'é'.repeat(300);
  assert.equal(m.utf8ByteLength(grown), 600);
  assert.equal(m.utf8ByteLength('a\u00e9\u20ac\u{1F600}\ud800'), 1 + 2 + 3 + 4 + 3);
  const vfs = () => installVfs([
    {path: 'a.txt', content: 'x', size: 1, read_content: grown},
    {path: 'b.txt', content: 'é'}
  ]);
  vfs();
  const perFile = await m.main({query: 'é', max_file_bytes: 10, max_total_bytes: 10});
  assert.deepEqual(perFile.results.map(x => x.path), ['b.txt']);
  assert.equal(perFile.coverage.skipped.too_large, 1);
  assert.deepEqual(perFile.coverage.skipped_examples, [{path: 'a.txt', reason: 'too_large', detail: '600 bytes read (listed 1)'}]);
  assert.equal(perFile.coverage.bytes_scanned, 2);
  assert.equal(perFile.coverage.scanned, 1);
  assert.equal(perFile.coverage.changed_since_listing, 1);
  assert.deepEqual(perFile.coverage.changed_examples, [{path: 'a.txt', listed_size: 1, read_bytes: 600, listed_mime: 'text/plain', read_mime: 'text/plain'}]);
  assert.equal(perFile.coverage.complete, false);
  assert.ok(perFile.notes.some(n => n.includes('changed between fs_list and fs_read')));

  // Under the per-file cap but over the total budget: stops the scan in path order.
  vfs();
  const total = await m.main({query: 'é', max_file_bytes: 1000, max_total_bytes: 10});
  assert.deepEqual(total.results, []);
  assert.equal(total.coverage.bytes_scanned, 0);
  assert.deepEqual(total.coverage.skipped, {binary: 0, too_large: 0, read_error: 0, over_file_cap: 0, over_byte_budget: 2, over_time_budget: 0});
  assert.equal(total.coverage.complete, false);
  assert.ok(total.notes.some(n => n.includes('over_byte_budget')));

  // Within both caps: searched, and bytes_scanned counts the 600 read bytes, not the listed 1.
  vfs();
  const fits = await m.main({query: 'é', max_file_bytes: 1000, max_total_bytes: 1000});
  assert.deepEqual(fits.results.map(x => x.path), ['a.txt', 'b.txt']);
  assert.equal(fits.coverage.bytes_scanned, 602);
  assert.equal(fits.coverage.complete, false);
});

test('a file that turns binary after listing is skipped by its fs_read MIME type', async () => {
  installVfs([{path: 'a.txt', content: 'needle', read_content: 'bmVlZGxl', read_mime_type: 'image/png'}]);
  const r = await m.main({query: 'needle'});
  assert.deepEqual(r.results, []);
  assert.equal(r.coverage.skipped.binary, 1);
  assert.equal(r.coverage.skipped_examples[0].detail, 'image/png at read time');
  assert.equal(r.coverage.changed_since_listing, 1);
  assert.equal(r.coverage.complete, false);
});

test('binary-only exclusions still count as complete coverage', async () => {
  installVfs([{path: 'a.txt', content: 'needle'}, {path: 'b.png', content: 'x', mime_type: 'image/png'}]);
  const r = await m.main({query: 'needle'});
  assert.equal(r.coverage.complete, true);
  assert.equal(r.coverage.skipped.binary, 1);
});

test('prefix is forwarded with _full; file cap and byte budget stop in path order and report it', async () => {
  const files = Array.from({length: 6}, (_, i) => ({path: `data/f${i}.txt`, content: 'hit'}));
  const calls = installVfs([...files, {path: 'other/x.txt', content: 'hit'}]);
  const r = await m.main({query: 'hit', prefix: 'data/', max_files: 4});
  assert.deepEqual(calls[0], {tool: 'fs_list', input: {prefix: 'data/', _full: true}});
  assert.equal(r.coverage.scanned, 4);
  assert.equal(r.coverage.skipped.over_file_cap, 2);
  assert.equal(r.coverage.complete, false);
  assert.deepEqual(r.results.map(x => x.path), ['data/f0.txt', 'data/f1.txt', 'data/f2.txt', 'data/f3.txt']);
  assert.ok(r.notes.some(n => n.includes('over_file_cap')));
  const budget = await m.main({query: 'hit', prefix: 'data/', max_total_bytes: 7});
  assert.equal(budget.coverage.scanned, 2);
  assert.equal(budget.coverage.skipped.over_byte_budget, 4);
});

test('limit is clamped and truncation of results / per-file matches is flagged', async () => {
  installVfs(Array.from({length: 3}, (_, i) => ({path: `f${i}.txt`, content: 'x\nx\nx'})));
  const r = await m.main({query: 'x', limit: 2, max_matches_per_file: 1});
  assert.equal(r.results.length, 2);
  assert.equal(r.total_matching_files, 3);
  assert.equal(r.results_truncated, true);
  assert.equal(r.results[0].match_count, 3);
  assert.equal(r.results[0].matches.length, 1);
  assert.equal(r.results[0].matches_truncated, true);
  assert.equal(m.validateArgs({query: 'x', limit: 10000}).limit, m.BOUNDS.limit[1]);
  assert.equal(m.validateArgs({query: 'x', max_file_bytes: 1e12}).max_file_bytes, m.BOUNDS.max_file_bytes[1]);
});

test('a truncated string listing is parsed and reported as incomplete', async () => {
  installVfs([{path: 'a.txt', content: 'hit'}, {path: 'b.txt', content: 'hit'}], {listAsTruncatedString: true});
  const r = await m.main({query: 'hit'});
  assert.equal(r.results.length, 1);
  assert.equal(r.coverage.complete, false);
  assert.ok(r.notes[0].includes('truncated listing'));
});

test('long lines produce bounded snippets centred on the match', async () => {
  installVfs([{path: 'wide.txt', content: 'a'.repeat(1000) + 'MARK' + 'b'.repeat(1000)}]);
  const snippet = (await m.main({query: 'MARK'})).results[0].matches[0].snippet;
  assert.ok(snippet.length <= 202 && snippet.includes('MARK') && snippet.startsWith('…') && snippet.endsWith('…'));
});

test('invalid arguments are rejected with actionable errors', async () => {
  installVfs([]);
  for (const args of [{}, {query: '  '}, {query: 'x', mode: 'fuzzy'}, {query: 'x', limit: 0}, {query: 'x', limit: Infinity},
    {query: 'x', prefix: 3}, {query: 'x'.repeat(1001)}, {query: 'x'.repeat(257), mode: 'regex'}, {query: '!!!', mode: 'bm25'}]) {
    await assert.rejects(m.main(args), undefined, JSON.stringify(args).slice(0, 60));
  }
});
