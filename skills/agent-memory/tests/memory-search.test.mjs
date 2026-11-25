import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'node:test';

// Pure helpers only. tests/unit/memory-search-skill-sandbox.test.ts runs the
// whole lambda in the real sandbox against a real ADF database.
const code = readFileSync(new URL('../scripts/memory-search.js', import.meta.url), 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('queryTerms: distinct non-stopword tokens; operators and symbols are not syntax', () => {
  assert.deepEqual(m.queryTerms('What is the vendor for invoices? Vendor!'), ['vendor', 'invoices']);
  assert.deepEqual(m.queryTerms('NEAR(a* "b" ^c) AND'), ['near', 'b', 'c']);
  assert.deepEqual(m.queryTerms('the of'), ['the', 'of']); // only stopwords: keep them
  assert.deepEqual(m.queryTerms('*** ()'), []);
});

test('tokens: lowercased letter/digit runs with diacritics removed, like FTS5 unicode61', () => {
  assert.deepEqual(m.tokens('Déploiement 2026, RÉSUMÉ of Zoë'), ['deploiement', '2026', 'resume', 'of', 'zoe']);
  assert.deepEqual(m.tokens('[[S12] main · 2026-11-20]'), ['s12', 'main', '2026', '11', '20']);
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

test('messageText: text, tool results, and what the agent sent; thinking and other tool inputs left out', () => {
  const blocks = [
    {type: 'thinking', thinking: 'secret'},
    {type: 'text', text: 'hello'},
    {type: 'tool_use', name: 'fs_write', input: {content: 'ignored'}},
    {type: 'tool_use', name: 'msg_send', input: {recipient: 'telegram:1', content: 'sent'}},
    {type: 'tool_use', name: 'say', input: {message: 'said'}},
    {type: 'tool_use', name: 'loop_send', input: {to_loop: 'planner', content: 'looped'}},
    {type: 'tool_use', name: 'ask', input: {questions: [{question: 'q1?'}, {question: 'q2?'}]}},
    {type: 'tool_result', content: 'result one'},
    {type: 'tool_result', content: [{type: 'text', text: 'result two'}]}
  ];
  const expected = 'hello\n\nsent\n\nsaid\n\nlooped\n\nq1?\n\nq2?\n\nresult one\n\nresult two';
  assert.equal(m.messageText(blocks), expected);
  assert.equal(m.messageText(JSON.stringify(blocks)), expected); // live rows hold a JSON string
});
