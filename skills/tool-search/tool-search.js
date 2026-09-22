// Bounded runtime tool discovery and visibility helper.
// Searches all enabled built-in and MCP tools from sys_get_config({section:'tools'}).
// It reveals bounded matches and can sequentially restore a compact visible baseline.
// Visibility changes never alter enablement, restriction, locking, or authorization.

const DEFAULT_THRESHOLD = 0.34;
const DEFAULT_MAX_MATCHES = 5;
const HARD_MAX_MATCHES = 10;
const MAX_CATALOG_TOOLS = 5000;
const MAX_SCHEMA_SEARCH_CHARS = 24000;

// Small cold-path working set. Everything else can stay enabled but hidden and
// be surfaced on demand by keyword search.
const CORE_VISIBLE_TOOLS = [
  'say', 'ask', 'fs_read', 'fs_write', 'fs_list',
  'msg_list', 'msg_read', 'msg_send', 'msg_update',
  'sys_code', 'sys_lambda', 'sys_set_state'
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'tool', 'tools', 'use',
  'with', 'your'
]);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(token) {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokens(value) {
  return [...new Set(normalize(value)
    .split(' ')
    .map(stem)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token)))];
}

function bigrams(value) {
  const text = normalize(value).replace(/\s+/g, ' ');
  if (!text) return [];
  if (text.length === 1) return [text];
  const out = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  const aa = bigrams(a);
  const bb = bigrams(b);
  if (!aa.length || !bb.length) return 0;
  const counts = new Map();
  for (const gram of aa) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of bb) {
    const count = counts.get(gram) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (aa.length + bb.length);
}

function schemaText(schema) {
  if (!schema || typeof schema !== 'object') return '';
  const values = [];
  const visit = (node, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      values.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node).slice(0, 100)) {
      values.push(key);
      visit(value, depth + 1);
    }
  };
  visit(schema);
  return values.join(' ').slice(0, MAX_SCHEMA_SEARCH_CHARS);
}

function scoreTool(query, tool) {
  const q = normalize(query);
  const name = normalize(tool.name);
  const description = normalize(tool.description);
  const schema = normalize(schemaText(tool.schema));
  const combined = `${name} ${description} ${schema}`.trim();
  const qTokens = tokens(q);
  const nameTokens = new Set(tokens(name));
  const descTokens = new Set(tokens(description));
  const schemaTokens = new Set(tokens(schema));

  let tokenScore = 0;
  const matchedTokens = [];
  for (const token of qTokens) {
    if (nameTokens.has(token)) {
      tokenScore += 1;
      matchedTokens.push(token);
    } else if (descTokens.has(token)) {
      tokenScore += 0.78;
      matchedTokens.push(token);
    } else if (schemaTokens.has(token)) {
      tokenScore += 0.62;
      matchedTokens.push(token);
    } else {
      const candidates = [...nameTokens, ...descTokens, ...schemaTokens];
      let best = 0;
      for (const candidate of candidates) {
        if (Math.abs(candidate.length - token.length) > 4) continue;
        best = Math.max(best, diceCoefficient(token, candidate));
      }
      if (best >= 0.72) {
        tokenScore += 0.48 * best;
        matchedTokens.push(token);
      }
    }
  }

  const coverage = qTokens.length ? tokenScore / qTokens.length : 0;
  const phraseBoost = combined.includes(q) ? 0.32 : 0;
  const namePhraseBoost = name.includes(q) || q.includes(name) ? 0.28 : 0;
  const fuzzy = Math.max(
    diceCoefficient(q, name),
    diceCoefficient(q, description.slice(0, Math.max(80, q.length * 5))) * 0.7
  );
  const score = Math.min(1, coverage * 0.72 + phraseBoost + namePhraseBoost + fuzzy * 0.18);
  return { score, matchedTokens: [...new Set(matchedTokens)] };
}

function validateArgs(args) {
  const query = String(args.query || args.q || '').trim();
  if (query.length < 2) throw new Error('Provide a query with at least 2 characters.');
  if (query.length > 1000) throw new Error('Query must not exceed 1000 characters.');
  if (!tokens(query).length) throw new Error('Query must contain searchable keywords.');
  const requestedMax = Number(args.max_matches ?? args.maxMatches ?? DEFAULT_MAX_MATCHES);
  const requestedThreshold = Number(args.threshold ?? DEFAULT_THRESHOLD);
  if (!Number.isFinite(requestedMax) || !Number.isFinite(requestedThreshold)) throw new Error('Bounds must be finite numbers.');
  const maxMatches = Math.min(
    HARD_MAX_MATCHES,
    Math.max(1, Math.floor(requestedMax))
  );
  const threshold = Math.min(1, Math.max(0, requestedThreshold));
  const includeDisabled = args.include_disabled === true || args.includeDisabled === true;
  return { query, maxMatches, threshold, includeDisabled };
}

async function catalog() {
  const config = await adf.sys_get_config({
    section: 'tools',
    _reason: 'Search runtime tool catalog and schemas'
  });
  const tools = Array.isArray(config?.tools) ? config.tools.slice(0, MAX_CATALOG_TOOLS) : [];
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    schema: tool.schema || {},
    enabled: Boolean(tool.enabled),
    visible: Boolean(tool.visible),
    restricted: Boolean(tool.restricted ?? tool.restrictions?.restricted),
    locked: Boolean(tool.locked ?? tool.restrictions?.locked),
    source: tool.source || 'unknown'
  }));
}

async function search(args = {}) {
  const { query, maxMatches, threshold, includeDisabled } = validateArgs(args);
  const tools = await catalog();
  const searchable = includeDisabled ? tools : tools.filter(tool => tool.enabled);
  const matches = searchable
    .map(tool => ({ tool, ...scoreTool(query, tool) }))
    .filter(item => item.score >= threshold)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, maxMatches)
    .map(item => ({
      ...item.tool,
      score: Number(item.score.toFixed(4)),
      matched_tokens: item.matchedTokens,
      visibility_change_available: item.tool.enabled && !item.tool.visible && !item.tool.locked
    }));
  return {
    ok: true,
    query,
    threshold,
    max_matches: maxMatches,
    catalog_count: tools.length,
    searchable_count: searchable.length,
    include_disabled: includeDisabled,
    match_count: matches.length,
    matches
  };
}

async function reveal(args = {}) {
  const result = await search(args);
  const dryRun = args.dry_run === true || args.dryRun === true || args.apply === false;
  const allowRestricted = args.allow_restricted === true || args.allowRestricted === true;
  const changed = [];
  const unchanged = [];
  const skipped = [];

  for (const match of result.matches) {
    if (!match.enabled) {
      skipped.push({ name: match.name, reason: 'disabled_visibility_would_not_make_callable' });
      continue;
    }
    if (match.visible) {
      unchanged.push({ name: match.name, reason: 'already_visible' });
      continue;
    }
    if (match.locked) {
      skipped.push({ name: match.name, reason: 'locked' });
      continue;
    }
    if (match.restricted && !allowRestricted) {
      skipped.push({ name: match.name, reason: 'restricted_requires_allow_restricted' });
      continue;
    }
    if (dryRun) {
      changed.push({ name: match.name, from: false, to: true, applied: false });
      continue;
    }
    await adf.sys_update_config({
      path: `tools.${match.name}.visible`,
      value: true,
      action: 'set',
      _reason: `Reveal fuzzy-matched tool ${match.name}`
    });
    changed.push({ name: match.name, from: false, to: true, applied: true });
  }

  return {
    ...result,
    dry_run: dryRun,
    changed,
    unchanged,
    skipped,
    note: 'Visibility only. Tool enabled/restricted/locked state was not changed.'
  };
}

async function resetVisibility(args = {}) {
  const tools = await catalog();
  const requested = Array.isArray(args.core_tools || args.coreTools)
    ? (args.core_tools || args.coreTools).map(String)
    : CORE_VISIBLE_TOOLS;
  const known = new Set(tools.map(tool => tool.name));
  const core = [...new Set(requested.filter(name => known.has(name)))];
  const coreSet = new Set(core);
  const unknown_core_tools = requested.filter(name => !known.has(name));
  const dryRun = args.dry_run === true || args.dryRun === true || args.apply === false;
  const changed = [];
  const unchanged = [];
  const skipped = [];
  const nextTools = [];

  for (const tool of tools) {
    const targetVisible = coreSet.has(tool.name) && tool.enabled;
    if (tool.visible === targetVisible) {
      unchanged.push({ name: tool.name, visible: tool.visible });
    } else if (tool.locked) {
      skipped.push({ name: tool.name, reason: 'locked', current: tool.visible, requested: targetVisible });
    } else {
      changed.push({ name: tool.name, from: tool.visible, to: targetVisible, applied: !dryRun });
    }
    nextTools.push({
      name: tool.name,
      enabled: tool.enabled,
      visible: tool.locked ? tool.visible : targetVisible,
      ...(tool.restricted ? { restricted: true } : {}),
      ...(tool.locked ? { locked: true } : {})
    });
  }

  if (!dryRun && changed.length) {
    // Update visibility fields only. Whole-array replacement can collide with
    // runtime-generated declarations and discards other tool configuration.
    for (const change of changed) {
      await adf.sys_update_config({
        path: `tools.${change.name}.visible`,
        value: change.to,
        action: 'set',
        _reason: `Reset visibility for ${change.name}`
      });
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    catalog_count: tools.length,
    core_tools: core,
    unknown_core_tools,
    changed,
    unchanged_count: unchanged.length,
    skipped,
    update_calls: dryRun ? 0 : changed.length,
    note: 'Visibility only. Enabled, restricted, and locked state was preserved.'
  };
}

async function main(args = {}) {
  const task = args.task || 'search';
  if (task === 'catalog') return { ok: true, tools: await catalog() };
  if (task === 'search') return await search(args);
  if (task === 'reveal') return await reveal(args);
  if (task === 'reset' || task === 'reset_visibility') return await resetVisibility(args);
  throw new Error(`Unknown task: ${task}. Use catalog, search, reveal, or reset.`);
}

export { main, catalog, search, reveal, resetVisibility, scoreTool, CORE_VISIBLE_TOOLS };
