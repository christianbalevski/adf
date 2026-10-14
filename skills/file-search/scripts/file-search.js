// Bounded, dependency-free search over the agent's virtual filesystem.
// Modes: exact (literal substring), bm25 (Okapi BM25 over whole files), regex.
// Reads files through adf.fs_list / adf.fs_read only; no index, no writes, no
// config changes. Every skipped or unscanned file is counted in `coverage`.

const MODES = ['exact', 'bm25', 'regex'];
const DEFAULT_MODE = 'exact';

// [default, hard maximum] for each caller-tunable bound.
const BOUNDS = {
  limit: [20, 100],
  max_matches_per_file: [5, 50],
  max_files: [2000, 5000],
  max_file_bytes: [512 * 1024, 2 * 1024 * 1024],
  max_total_bytes: [8 * 1024 * 1024, 32 * 1024 * 1024],
  time_budget_ms: [15000, 50000]
};

const MAX_QUERY_CHARS = 1000;
const MAX_REGEX_CHARS = 256;
const MAX_REGEX_LINE_CHARS = 4000;
const SNIPPET_CHARS = 200;
const MAX_SKIPPED_EXAMPLES = 20;
const MAX_BOOSTS = 10;

const DEFAULT_RANKING = { k1: 1.2, b: 0.75, path_weight: 0.5, boosts: [], sort: 'score' };

// Mirrors src/main/tools/built-in/mime-utils.ts isTextMime: anything else is
// returned by fs_read as base64 and is skipped here as binary.
const TEXT_MIME_EXACT = new Set([
  'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
  'application/javascript', 'application/typescript', 'application/x-sh',
  'application/sql', 'application/graphql', 'application/xhtml+xml',
  'application/x-httpd-php', 'application/x-ndjson', 'application/ndjson',
  'application/csv', 'application/toml'
]);

function isTextMime(mime) {
  if (!mime) return false;
  if (mime.startsWith('text/')) return true;
  if (/\+(json|xml|yaml)$/.test(mime)) return true;
  return TEXT_MIME_EXACT.has(mime);
}

// --- Argument validation ---------------------------------------------------

function boundedInt(args, key) {
  const [fallback, max] = BOUNDS[key];
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    throw new Error(`${key} must be a positive finite number (max ${max}).`);
  }
  return Math.min(Math.floor(raw), max);
}

function boundedNumber(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`ranking.${name} must be a number between ${min} and ${max}.`);
  }
  return value;
}

// Rejects any key outside `allowed`, whatever its value (functions included).
function rejectUnknownKeys(input, allowed, label) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key "${key}". Allowed: ${allowed.join(', ')}.`);
  }
}

// The ranking contract is plain data: BM25 parameters, a path-field weight,
// prefix multipliers, and a sort key. Functions or unknown keys are rejected at
// every level, so a caller cannot smuggle executable ranking logic into the scan.
function validateRanking(input) {
  if (input === undefined || input === null) return { ...DEFAULT_RANKING };
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('ranking must be an object.');
  rejectUnknownKeys(input, Object.keys(DEFAULT_RANKING), 'ranking');
  const sort = input.sort === undefined ? 'score' : input.sort;
  if (sort !== 'score' && sort !== 'path') throw new Error('ranking.sort must be "score" or "path".');
  const boosts = input.boosts === undefined ? [] : input.boosts;
  if (!Array.isArray(boosts) || boosts.length > MAX_BOOSTS) {
    throw new Error(`ranking.boosts must be an array of at most ${MAX_BOOSTS} { prefix, weight } entries.`);
  }
  return {
    k1: boundedNumber(input.k1, 'k1', 0, 3, DEFAULT_RANKING.k1),
    b: boundedNumber(input.b, 'b', 0, 1, DEFAULT_RANKING.b),
    path_weight: boundedNumber(input.path_weight, 'path_weight', 0, 5, DEFAULT_RANKING.path_weight),
    boosts: boosts.map((boost, i) => {
      if (!boost || typeof boost !== 'object' || Array.isArray(boost) || typeof boost.prefix !== 'string') {
        throw new Error(`ranking.boosts[${i}] must be { prefix: string, weight: number }.`);
      }
      rejectUnknownKeys(boost, ['prefix', 'weight'], `ranking.boosts[${i}]`);
      return { prefix: boost.prefix, weight: boundedNumber(boost.weight, `boosts[${i}].weight`, 0, 10, 1) };
    }),
    sort
  };
}

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object.');
  const mode = args.mode === undefined ? DEFAULT_MODE : args.mode;
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}.`);
  if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query must be a non-empty string.');
  const query = mode === 'regex' ? args.query : args.query.trim();
  const maxChars = mode === 'regex' ? MAX_REGEX_CHARS : MAX_QUERY_CHARS;
  if (query.length > maxChars) throw new Error(`query must not exceed ${maxChars} characters in ${mode} mode.`);
  if (args.prefix !== undefined && typeof args.prefix !== 'string') throw new Error('prefix must be a string.');
  return {
    query,
    mode,
    prefix: args.prefix || '',
    case_sensitive: args.case_sensitive === true,
    allow_unsafe_regex: args.allow_unsafe_regex === true,
    limit: boundedInt(args, 'limit'),
    max_matches_per_file: boundedInt(args, 'max_matches_per_file'),
    max_files: boundedInt(args, 'max_files'),
    max_file_bytes: boundedInt(args, 'max_file_bytes'),
    max_total_bytes: boundedInt(args, 'max_total_bytes'),
    time_budget_ms: boundedInt(args, 'time_budget_ms'),
    ranking: validateRanking(args.ranking)
  };
}

// --- Matchers ----------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Heuristic screen for patterns prone to catastrophic backtracking. It catches
// common shapes only; passing it is not a safety guarantee.
function unsafeRegexReason(pattern) {
  if (/\\[1-9]|\\k</.test(pattern)) return 'backreference';
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return 'nested quantifier';
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return 'quantified alternation';
  return null;
}

function compileMatcher(opts) {
  const flags = opts.case_sensitive ? '' : 'i';
  if (opts.mode === 'exact') return new RegExp(escapeRegExp(opts.query), flags);
  if (!opts.allow_unsafe_regex) {
    const reason = unsafeRegexReason(opts.query);
    if (reason) {
      throw new Error(`Regex rejected (${reason}): it may backtrack catastrophically. Simplify it, or pass allow_unsafe_regex: true and accept that only the sandbox execution timeout can stop it.`);
    }
  }
  let re;
  try {
    re = new RegExp(opts.query, flags);
  } catch (error) {
    throw new Error(`Invalid regex: ${error.message}`);
  }
  if (re.test('')) throw new Error('Regex matches the empty string, so it would match every line. Make it require at least one character.');
  return re;
}

function snippetAround(line, start, length) {
  if (line.length <= SNIPPET_CHARS) return line.trim();
  const lead = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  const from = Math.max(0, Math.min(start - lead, line.length - SNIPPET_CHARS));
  const to = Math.min(line.length, from + SNIPPET_CHARS);
  return `${from > 0 ? '…' : ''}${line.slice(from, to).trim()}${to < line.length ? '…' : ''}`;
}

// Line numbers are 1-indexed and split on '\n' exactly as fs_read's
// start_line/end_line do, so a match can be opened with a ranged fs_read.
function splitLines(content) {
  return content.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function scanLiteralOrRegex(lines, re, opts, stats) {
  const matches = [];
  let matchCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (opts.mode === 'regex' && line.length > MAX_REGEX_LINE_CHARS) {
      line = line.slice(0, MAX_REGEX_LINE_CHARS);
      stats.long_lines_truncated += 1;
    }
    const m = re.exec(line);
    if (!m) continue;
    matchCount += 1;
    if (matches.length < opts.max_matches_per_file) {
      matches.push({ line: i + 1, column: m.index + 1, snippet: snippetAround(line, m.index, m[0].length) });
    }
  }
  return { matchCount, matches };
}

// --- BM25 --------------------------------------------------------------------

// Lowercased Unicode letter/digit runs. No stemming or stop words: the
// tokenizer is deliberately simple and deterministic.
function tokenize(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function termFrequencies(tokens, terms) {
  const tf = new Map();
  for (const token of tokens) if (terms.has(token)) tf.set(token, (tf.get(token) || 0) + 1);
  return tf;
}

// Okapi BM25 with the non-negative Lucene IDF:
//   idf(t) = ln(1 + (N - n_t + 0.5) / (n_t + 0.5))
//   score  = Σ idf(t) · tf·(k1+1) / (tf + k1·(1 - b + b·len/avglen))
// `docs` is [{ tf: Map<term, count>, length }]. Returns one score per doc.
function bm25Scores(docs, terms, { k1, b }) {
  const n = docs.length;
  if (!n) return [];
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / n || 1;
  const idf = new Map();
  for (const term of terms) {
    const df = docs.reduce((count, doc) => count + (doc.tf.has(term) ? 1 : 0), 0);
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  return docs.map(doc => {
    let score = 0;
    for (const term of terms) {
      const tf = doc.tf.get(term) || 0;
      if (!tf) continue;
      score += idf.get(term) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / avgLength));
    }
    return score;
  });
}

// One pass per line: whole-document term frequencies and length (tokens never
// span '\n', so this equals tokenizing the whole file) plus line locations.
function bm25ScanLines(lines, terms, opts) {
  const tf = new Map();
  let length = 0;
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const present = new Set();
    let first = -1;
    for (const m of lines[i].matchAll(/[\p{L}\p{N}]+/gu)) {
      length += 1;
      const token = m[0].toLowerCase();
      if (!terms.has(token)) continue;
      tf.set(token, (tf.get(token) || 0) + 1);
      present.add(token);
      if (first < 0) first = m.index;
    }
    if (present.size) hits.push({ line: i + 1, column: first + 1, distinct: present.size, snippet: snippetAround(lines[i], first, 0) });
  }
  // Most distinct query terms first, then earliest line.
  hits.sort((a, b) => b.distinct - a.distinct || a.line - b.line);
  return {
    tf,
    length,
    lineHits: {
      matchCount: hits.length,
      matches: hits.slice(0, opts.max_matches_per_file).map(({ line, column, snippet }) => ({ line, column, snippet }))
    }
  };
}

// UTF-8 byte length of a JS string, counted by hand so it does not depend on
// Buffer or TextEncoder being present in the sandbox realm. Lone surrogates
// count as 3 bytes (U+FFFD), as Buffer.byteLength does.
function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// --- Filesystem access ---------------------------------------------------------

async function listFiles(prefix) {
  // _full bypasses fs_list's 500-entry model-facing cap. If a runtime ignores
  // it, the result is a string with a TRUNCATED footer: parse the JSON line and
  // report the listing as incomplete.
  const listed = await adf.fs_list(prefix ? { prefix, _full: true } : { _full: true });
  if (Array.isArray(listed)) return { entries: listed, listingTruncated: false };
  if (typeof listed === 'string') {
    const firstLine = listed.split('\n')[0];
    try {
      const entries = JSON.parse(firstLine);
      if (Array.isArray(entries)) return { entries, listingTruncated: /TRUNCATED/.test(listed) };
    } catch { /* fall through */ }
  }
  throw new Error('fs_list returned an unexpected shape; cannot enumerate files.');
}

// --- Search ------------------------------------------------------------------

function boostFor(path, boosts) {
  let best = null;
  for (const boost of boosts) {
    if (path.startsWith(boost.prefix) && (!best || boost.prefix.length > best.prefix.length)) best = boost;
  }
  return best ? best.weight : 1;
}

async function search(args = {}) {
  const opts = validateArgs(args);
  const startedAt = Date.now();
  const re = opts.mode === 'bm25' ? null : compileMatcher(opts);
  const terms = opts.mode === 'bm25' ? new Set(tokenize(opts.query)) : null;
  if (terms && !terms.size) throw new Error('bm25 query must contain at least one letter or digit.');

  const { entries, listingTruncated } = await listFiles(opts.prefix);
  const files = entries
    .filter(entry => entry && typeof entry.path === 'string' && entry.path.startsWith(opts.prefix))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const skipped = { binary: 0, too_large: 0, read_error: 0, over_file_cap: 0, over_byte_budget: 0, over_time_budget: 0 };
  const skippedExamples = [];
  // Files whose fs_read size or MIME type differ from the fs_list row.
  let changedSinceListing = 0;
  const changedExamples = [];
  const skip = (path, reason, detail) => {
    skipped[reason] += 1;
    if (skippedExamples.length < MAX_SKIPPED_EXAMPLES) skippedExamples.push(detail ? { path, reason, detail } : { path, reason });
  };
  const stats = { long_lines_truncated: 0 };
  const scannedDocs = [];
  let bytesScanned = 0;
  let stopReason = null;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const listedSize = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null;
    const size = listedSize !== null && listedSize > 0 ? listedSize : 0;
    if (!isTextMime(file.mime_type)) {
      skip(file.path, 'binary', file.mime_type || 'no mime type');
      continue;
    }
    if (size > opts.max_file_bytes) {
      skip(file.path, 'too_large', `${size} bytes`);
      continue;
    }
    if (!stopReason) {
      if (scannedDocs.length >= opts.max_files) stopReason = 'over_file_cap';
      else if (Date.now() - startedAt > opts.time_budget_ms) stopReason = 'over_time_budget';
      else if (bytesScanned + size > opts.max_total_bytes) stopReason = 'over_byte_budget';
    }
    if (stopReason) {
      skip(file.path, stopReason);
      continue;
    }
    // The pre-read checks above use the fs_list row, which can be stale. fs_read
    // returns the whole file, so a file that grew after listing is already in
    // sandbox memory here; the checks below decide only whether it is searched
    // and counted, using what was actually read.
    let content;
    let read;
    try {
      read = await adf.fs_read({ path: file.path });
      content = read && typeof read === 'object' ? read.content : null;
    } catch (error) {
      skip(file.path, 'read_error', String((error && error.message) || error).slice(0, 200));
      continue;
    }
    if (typeof content !== 'string') {
      skip(file.path, 'read_error', 'no text content returned');
      continue;
    }
    const readMime = read.mime_type === undefined ? file.mime_type : read.mime_type;
    const readBytes = utf8ByteLength(content);
    const readSize = typeof read.size === 'number' && Number.isFinite(read.size) ? read.size : readBytes;
    if (readMime !== file.mime_type || (listedSize !== null && readSize !== listedSize)) {
      changedSinceListing += 1;
      if (changedExamples.length < MAX_SKIPPED_EXAMPLES) {
        changedExamples.push({ path: file.path, listed_size: file.size, read_bytes: readBytes, listed_mime: file.mime_type ?? null, read_mime: readMime ?? null });
      }
    }
    if (!isTextMime(readMime)) {
      skip(file.path, 'binary', `${readMime || 'no mime type'} at read time`);
      continue;
    }
    if (content.includes('\u0000')) {
      skip(file.path, 'binary', 'NUL byte in text content');
      continue;
    }
    if (readBytes > opts.max_file_bytes) {
      skip(file.path, 'too_large', `${readBytes} bytes read (listed ${size})`);
      continue;
    }
    if (bytesScanned + readBytes > opts.max_total_bytes) {
      stopReason = 'over_byte_budget';
      skip(file.path, stopReason, `${readBytes} bytes read (listed ${size})`);
      continue;
    }
    bytesScanned += readBytes;

    const lines = splitLines(content);
    if (opts.mode === 'bm25') {
      const { lineHits, tf, length } = bm25ScanLines(lines, terms, opts);
      const pathTokens = tokenize(file.path);
      scannedDocs.push({
        path: file.path,
        lineHits,
        body: { tf, length },
        pathDoc: { tf: termFrequencies(pathTokens, terms), length: pathTokens.length }
      });
    } else {
      scannedDocs.push({ path: file.path, lineHits: scanLiteralOrRegex(lines, re, opts, stats) });
    }
  }

  let scored;
  if (opts.mode === 'bm25') {
    const bodyScores = bm25Scores(scannedDocs.map(doc => doc.body), terms, opts.ranking);
    const pathScores = bm25Scores(scannedDocs.map(doc => doc.pathDoc), terms, opts.ranking);
    scored = scannedDocs.map((doc, i) => ({ doc, raw: bodyScores[i] + opts.ranking.path_weight * pathScores[i] }));
  } else {
    scored = scannedDocs.map(doc => ({ doc, raw: doc.lineHits.matchCount }));
  }

  const ranked = scored
    .map(({ doc, raw }) => ({ doc, score: raw * boostFor(doc.path, opts.ranking.boosts) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => (opts.ranking.sort === 'path' ? 0 : b.score - a.score) || (a.doc.path < b.doc.path ? -1 : 1));

  const results = ranked.slice(0, opts.limit).map(({ doc, score }) => ({
    path: doc.path,
    score: Math.round(score * 10000) / 10000,
    match_count: doc.lineHits.matchCount,
    matches: doc.lineHits.matches,
    matches_truncated: doc.lineHits.matchCount > doc.lineHits.matches.length
  }));

  // Complete means every listed text file within bounds was searched in full
  // and nothing changed between fs_list and fs_read. Binary files are excluded
  // by design and counted separately.
  const gaps = files.length - scannedDocs.length - skipped.binary;
  const complete = !listingTruncated && gaps === 0 && stats.long_lines_truncated === 0 && changedSinceListing === 0;
  const notes = [];
  if (listingTruncated) notes.push('fs_list returned a truncated listing; files beyond it were never seen.');
  if (changedSinceListing) notes.push(`${changedSinceListing} file(s) changed between fs_list and fs_read (see coverage.changed_examples); caps and byte counts use what fs_read returned, and files added or removed after listing are not detected.`);
  if (stopReason) notes.push(`Scan stopped early (${stopReason}); files are scanned in path order, so later paths were not searched. Narrow prefix or raise the bound.`);
  if (skipped.too_large) notes.push('Files over max_file_bytes were skipped; read them in ranges with fs_read start_line/end_line.');
  if (stats.long_lines_truncated) notes.push(`Regex was applied to the first ${MAX_REGEX_LINE_CHARS} characters of ${stats.long_lines_truncated} long line(s).`);
  if (opts.mode === 'bm25') notes.push('BM25 statistics (IDF, average length) come from the scanned files only.');

  return {
    ok: true,
    mode: opts.mode,
    query: opts.query,
    prefix: opts.prefix,
    results,
    total_matching_files: ranked.length,
    results_truncated: ranked.length > results.length,
    coverage: {
      complete,
      listed: files.length,
      scanned: scannedDocs.length,
      bytes_scanned: bytesScanned,
      skipped,
      skipped_examples: skippedExamples,
      changed_since_listing: changedSinceListing,
      changed_examples: changedExamples,
      long_lines_truncated: stats.long_lines_truncated,
      elapsed_ms: Date.now() - startedAt
    },
    notes
  };
}

async function main(args = {}) {
  return await search(args);
}

export { main, search, tokenize, utf8ByteLength, bm25Scores, unsafeRegexReason, isTextMime, validateArgs, BOUNDS, DEFAULT_RANKING };
