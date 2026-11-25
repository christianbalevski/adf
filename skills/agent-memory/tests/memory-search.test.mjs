import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';

// Pure helpers only. tests/unit/memory-search-skill-sandbox.test.ts runs the
// whole lambda in the real sandbox against a real ADF database.
const code = readFileSync(new URL('../scripts/memory-search.js', import.meta.url), 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('validateArgs: query required, k clamped to 1..20, budget capped', () => {
  assert.throws(() => m.validateArgs({query: '  '}), /non-empty/);
  assert.throws(() => m.validateArgs({query: 'x'.repeat(1001)}), /1000/);
  for (const k of [0, -1, NaN, '5', Infinity]) assert.throws(() => m.validateArgs({query: 'x', k}), /k must be/);
  assert.equal(m.validateArgs({query: 'x'}).k, 8);
  assert.equal(m.validateArgs({query: 'x', k: 3.7}).k, 3);
  assert.equal(m.validateArgs({query: 'x', k: 1e9}).k, 20);
  assert.equal(m.validateArgs({query: 'x', budget_ms: 1e9}).budget_ms, 20000);
  assert.throws(() => m.validateArgs({query: 'x', budget_ms: -1}), /budget_ms/);
});

test('ftsQuery: quoted non-stopword terms joined with OR; operators are plain terms', () => {
  assert.equal(m.ftsQuery('What is the vendor for invoices?'), '"vendor" OR "invoices"');
  assert.equal(m.ftsQuery('NEAR(a* "b" ^c) AND'), '"near" OR "b" OR "c"');
  assert.equal(m.ftsQuery('the of'), '"the" OR "of"'); // only stopwords: keep them
  assert.equal(m.ftsQuery('*** ()'), null);
  assert.equal(m.ftsQuery('Déploiement 2026'), '"déploiement" OR "2026"');
});

test('chunkText: paragraph boundaries, ~1200 target, 1800 hard cap', () => {
  assert.deepEqual(m.chunkText('a\n\nb'), ['a\n\nb']);
  const paras = Array.from({length: 10}, (_, i) => `${i} ${'w'.repeat(500)}`);
  const chunks = m.chunkText(paras.join('\n\n'));
  for (const c of chunks) assert.ok(c.length <= 1200, c.length);
  assert.equal(chunks.join('\n\n'), paras.join('\n\n'));
  const long = m.chunkText('word '.repeat(2000));
  for (const c of long) assert.ok(c.length <= 1800, c.length);
  assert.equal(m.chunkText('x'.repeat(5000)).join(''), 'x'.repeat(5000)); // no boundary at all
  assert.deepEqual(m.chunkText('  \n\n  '), []);
});

test('messageText: text and tool results; thinking and tool inputs left out', () => {
  const blocks = [
    {type: 'thinking', thinking: 'secret'},
    {type: 'text', text: 'hello'},
    {type: 'tool_use', name: 'fs_write', input: {content: 'ignored'}},
    {type: 'tool_result', content: 'result one'},
    {type: 'tool_result', content: [{type: 'text', text: 'result two'}]}
  ];
  assert.equal(m.messageText(blocks), 'hello\n\nresult one\n\nresult two');
  assert.equal(m.messageText(JSON.stringify(blocks)), 'hello\n\nresult one\n\nresult two');
  assert.equal(m.messageText('not json'), 'not json');
  assert.equal(m.messageText(null), '');
});

test('dayOf: ms, seconds, and ISO strings', () => {
  assert.equal(m.dayOf(Date.UTC(2026, 10, 20, 12)), '2026-11-20');
  assert.equal(m.dayOf(Date.UTC(2026, 10, 20) / 1000), '2026-11-20');
  assert.equal(m.dayOf('2026-11-20T10:00:00.000Z'), '2026-11-20');
  assert.equal(m.dayOf(undefined), '');
});
