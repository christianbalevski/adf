// agent-import scrubber, loaded by SKILL.md. Load in sys_code:
//   const load = async p => { const m = { exports: {} }; new Function('module', (await adf.fs_read({ path: p })).content)(m); return m.exports; };
//   const S = await load('<skill folder>/scripts/scrub.js');
// scrub(text) -> { text, hits: [{ line, kind }] } redacts values (never keys, frontmatter, or env var names) and keeps the line count.
// unsafe(s): s trips scrub() or holds a risky token on a line with a secret-ish word. sift(o): drops model-output items that are unsafe.
// heldCheck(held, read, root): 'path:line' for source lines in the block under each held cite. pageFilter(page, risk, mark): last gate on generated pages.
// citeCheck(page, read, root): cites that point at no file, past its end, or at a blank line.
// flagged(text): broad count for the owner notice. asText(f): text from an fs_read record, null for binary. reply(r): model_invoke reply to JSON.
const R = k => '[REDACTED:' + k + ']';
const ENVNAME = /^\$?\{?[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\}?$/;   // GH_TOKEN, ${API_KEY}: names, kept
const SLUG = /^([a-z]+|\d{1,4})([-_.]([a-z]+|\d{1,4}))*$/i; // weekly-digest-2, claude-sonnet-4.5: kept
const SECRET_KEY = /(^|_)(password|passwd|passcode|passphrase|pwd|pin|secret|token|cookie|credentials?|api_?key|access_?key|secret_?key|private_?key|client_?secret|auth_?token|access_?token|refresh_?token|session_?token)$/;
const SHAPES = /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,}|glpat-[\w-]{20,}|sk-[\w-]{20,}|sk_live_\w{16,}|rk_live_\w{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|hf_[A-Za-z0-9]{30,}|ntn_\w{30,}|secret_[A-Za-z0-9]{40,}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}|\d{8,10}:[\w-]{35})\b/g;
const ASSIGN = /(^|[\s{,;(*|>-])(["']?)([A-Za-z_][\w.-]*)\2\s*[:=]\**[ \t]*("(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`|[^,;{}\[\]\s"'`|][^,;{}\]|]*)?/g;
const WORD = /\b(password|passwd|passcode|passphrase|secret|token|api key|pin)\b/i;
const TW = 'word|code|combination|combo|log[- ]?in|sign[- ]?in|lock(?:-up|\\w*)|padlock|alarm|keypad|door|gate|safe|wi-?fi|memorable|recovery|password|passcode|passphrase|pin|portal|pw';
const TRIG = new RegExp('\\b(' + TW + ')s?\\b', 'i');
const PHRASE = new RegExp('\\b(' + TW + ')s?\\b((?:\\s+[^\\s:=.!?]+){0,4}?)\\s*(\\bis\\b|\\bare\\b|:(?=\\s)|=|\\bopens (?:with|on)\\b|\\btakes\\b|(?<=\\b(?:log|sign)[- ]?ins?\\b.*)\\bwith\\b)\\s*([`"\']?)([^\\s`"\']+)\\4', 'gi');
const STOP = /^(in|on|at|the|a|an|not|now|still|also|stored|kept|saved|set|same|changed|here|there|my|your|our|this|that|to|from|by|with|for|of)$/i;
const FW = /^(the|and|for|with|you|your|that|this|from|have|has|had|are|was|were|will|but|not|his|her|our|they|them|then|than|when|what|been|into|its)$/i;
const SEEDRUN = /((?:^|[:=>(—–"'`]|\s-|\b(?:is|are|was)\b)\s*)([A-Za-z][a-z]{2,7}(?:[ ,]+[a-z]{3,8}){11}(?:(?:[ ,]+[a-z]{3,8}){12})?)(?=[`"')]?\.?\s*$)/; // 12 or 24 short words, label or not
const LEAD = /^(\s*(?:\d{1,2}[.)]\s*|[-*+]\s+)?(?:[^:\n]{0,40}:\s+)?)/; // list marker and short label
const LOCKW = '(?:lock(?:-up|\\w*)|padlock|alarm|keypad|safe|code|combination|combo|pin|passcode|password)s?';
const CODEN = /\b(codes?|combo|combination|pass\w*|pins?|pwd?|log-?ins?|log in|sign[- ]?in|recovery|backup|words?|secrets?|tokens?|alarm|keypad|memorable|phrase|seed)\b/i; // these lines lose the part-number exemption
const NUMW = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)', NUMRUN = new RegExp('\\b' + NUMW + '(?:[\\s,-]+' + NUMW + '){3,}\\b', 'gi'); // "four seven one one"
const NOTSEC = /\b(not|isn['’]t|is not|aren['’]t|never)\s+(a\s+|that\s+|really\s+)?(secret|sensitive|private)\b/i; // "the sheet ID isn't secret"
const XS = new RegExp('\\b(' + TW + ')s?\\s*[.!?]\\s+(?:it[\'’]?s|it is|that[\'’]?s|that is)\\s+([`"\']?)([^\\s`"\']+)\\2', 'gi'); // "safe word. It's Plum"
const nearLock = (line, off, t) => new RegExp('\\b' + LOCKW + '(\\s+(code|pin|number|is|was))*\\s*[:=-]?\\s*$', 'i').test(line.slice(0, off)) ||
  new RegExp('^\\s*(on|for|at|into)?\\s*(the\\s+)?' + LOCKW + '\\b', 'i').test(line.slice(off + t.length));
const yearKeep = (line, off, t) => /^(19|20)\d\d$/.test(t) && !nearLock(line, off, t); // years kept unless a lock word sits next to them
const keepNum = (line, off, t, b = line.slice(0, off)) => yearKeep(line, off, t) || /^(?=.*\d)[A-Z0-9]{2,}(-[A-Z0-9]{2,})+$/.test(t) && !nearLock(line, off, t) && !CODEN.test(line) || /\b([BHR]WV|RV|hymns?(\s+no\.?)?|psalms?|op(us|\.))\s*#?\s*$/i.test(b) || // part no.
  /^\d{4}$/.test(t) && /\b(card|account|acct)\b.{0,20}\b(ends?|ending)(\s+(in|with))?\s*[:-]?\s*$/i.test(b) || /^\d{2,5}$/.test(t) && /\bports?(\s+(is|number|no\.?|on))?\s*[:=#]?\s*$/i.test(b);
const asText = f => { const c = f.content; if (/^text\/|json|yaml|xml|markdown|javascript|csv/.test(f.mime_type || 'text/') || !/^[A-Za-z0-9+\/=\s]*$/.test(c)) return c;
  const t = Buffer.from(c, 'base64').toString('utf8'); return /[\uFFFD\u0000]/.test(t) ? null : t; }; // base64 for non-text mime; null = binary
const seedN = l => { const m = l.match(/^\s*(?:\d{1,2}[.)]\s*)?([a-z]{3,8}(?: [a-z]{3,8})*)\s*$/); return m && !m[1].split(' ').some(w => FW.test(w)) ? m[1].split(' ').length : 0; };
const codeLine = l => { const t = l.replace(LEAD, '').replace(/[`"']/g, '').replace(/\b(\w{4,5}) (\w{4,5})\b/g, '$1-$2').trim().split(/[\s,]+/);
  return t[0] && t.every(g => /^([A-Za-z0-9]{8,10}|[A-Za-z0-9]{4,5}-[A-Za-z0-9]{4,5})$/.test(g) && /\d/.test(g) && !/^(19|20)\d{6}$/.test(g)) ? t.length : 0; };
function prepass(L) { // seeds split over lines; 2FA code lists
  const pre = new Map(), scan = (f, ok, kind) => { for (let i = 0; i < L.length;) { let j = i; const n = []; while (j < L.length && f(L[j])) n.push(f(L[j++]));
    if (ok(n, L.slice(i, j))) for (let k = i; k < j; k++) pre.set(k, kind); i = j > i ? j : i + 1; } };
  scan(seedN, (n, ls) => { const t = n.reduce((a, b) => a + b, 0); return n.length > 1 && (t === 12 || t === 24) && (ls.every(l => /^\s*\d/.test(l)) || n.every(x => x === n[0])); }, 'seed');
  scan(codeLine, n => n.length >= 3 || n.reduce((a, b) => a + b, 0) >= 4, 'recovery');
  return pre;
}
const DATEISH = /^(\d{4}-\d{2}(-\d{2})?|\d{1,2}:\d{2}(:\d{2})?([ap]m)?|\d{1,2}[ap]m|v?\d+(\.\d+)+)$/i;
const keep = v => !v || /^(true|false|null|none|""|'')$/i.test(v) || ENVNAME.test(v) || /^<.*>$/.test(v) || v.startsWith('[REDACTED');
const looksSecret = v => /\d/.test(v) && /[A-Za-z]/.test(v) && !v.includes('://') && !/^[~\/.]/.test(v) && !/\.[a-z]{1,4}$/i.test(v) && !ENVNAME.test(v) && !SLUG.test(v) && !v.startsWith('[REDACTED');
const H = s => { const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1; return -Object.values(f).reduce((a, n) => a + n / s.length * Math.log2(n / s.length), 0); };
const risky = t => t.length >= 4 && !t.includes('REDACTED') && !t.includes('/') && !/^<[\w.-]+>$/.test(t) && !/^\d{1,5}-(word|line|char|minute|hour|day|week|month|year|step|page|item|point|mile)s?$/i.test(t) && !/\.[a-z]{1,4}$/i.test(t) && !ENVNAME.test(t) && !DATEISH.test(t) &&
  !(SLUG.test(t) && (t.match(/[a-z]{3,}/gi) || []).length >= 2) &&
  (/\d/.test(t) || (/[a-z][A-Z]/.test(t) && !/^([A-Z]?[a-z]+)+([A-Z]{2,})?$/.test(t)) || (t.length >= 12 && /\W/.test(t) && H(t) > 3.5));
const GUARD = /\b(codes?|pins?|combo|combination|pass\w*|pwd?|(pad|key)?lock(?!smith)\w*|lock-up|keypad|alarm)\b/i; // without one of these, phones and refs survive
const KEEPTOK = /(?<![\w+-])(\+44 ?|0)\d{2,4}( ?\d{3,4}){1,2}(?![\w-])|(?<![\w-])[A-Z]{2,4}-\d{3,8}(?![\w-])/g; // 01539 733905, GHB-77314
const REFTOK = /(?<=\b(?:ref|reference|booking)(?:\s+(?:no\.?|number))?\s*[:#]?\s*)[A-Z0-9]{5,8}(?![\w-])/gi; // booking ref 7HQ2KD
const pin = (m, kt) => (kt.push(m), '\uE000' + String.fromCharCode(0xE100 + kt.length - 1) + '\uE000');
const protect = (line, kt) => { if (!/\b(pass\w*|pwd?|pins?|combo|(pad|key)?lock(?!smith)\w*|keypad|alarm|secrets?|tokens?)\b/i.test(line)) line = line.replace(REFTOK, m => /^[A-Z0-9]+$/.test(m) && /\d/.test(m) && /[A-Z]/.test(m) ? pin(m, kt) : m);
  return GUARD.test(line) ? line : line.replace(KEEPTOK, m => { const d = m.replace(/\D/g, '').length; return /^[A-Z]/.test(m) || (m[0] === '+' ? d >= 11 && d <= 12 : d >= 10 && d <= 11) ? pin(m, kt) : m; }); };
const wordTok = t => /[:=]$/.test(t) || /^[[(]/.test(t) || /^([A-Z]?[a-z]+|[A-Z]+)[,.]?$/.test(t) && (/[aeiouy]/i.test(t) || TRIG.test(t)); // labels and plain words
const kg = x => /\d/.test(x) || /[a-z][A-Z]/.test(x) || !/[aeiouy]/i.test(x); // key-like group
const grouped = (line, hit) => line.replace(/(?<![\w.\/+=-])[A-Za-z0-9]{3,8}( [A-Za-z0-9]{3,8}){4,}(?![\w-])/g, run => { const g = run.split(' '), o = []; // key in 5+ space-separated groups
  for (let i = 0; i < g.length;) { if (!kg(g[i])) { o.push(g[i++]); continue; } let j = i; // one plain group may sit between key-like ones
    for (;;) { if (j + 1 < g.length && kg(g[j + 1])) j++; else if (j + 2 < g.length && kg(g[j + 2])) j += 2; else break; }
    const w = g.slice(i, j + 1); o.push(...(w.length >= 5 && w.filter(x => /\d/.test(x)).length >= 2 && w.some(x => /[a-z]/i.test(x)) ? [hit('grouped')] : w)); i = j + 1; }
  return o.join(' '); });
function scrub(text) {
  const hits = [];
  text = text.replace(/-----BEGIN [A-Z ]*KEY-----[\s\S]*?-----END [A-Z ]*KEY-----/g, (m, off) => { const a = text.slice(0, off).split('\n').length, n = m.split('\n').length; // line count kept, so cites match the drop
    for (let k = 0; k < n; k++) hits.push({ line: a + k, kind: 'pem' }); return R('pem') + '\n'.repeat(n - 1); });
  let carry = false, fence = false, xend = false; // carry: a key ending in ":" redacts a lone value on the next line
  const L = text.split('\n'), pre = prepass(L), sp = new Set();
  const lines = L.map((line, i) => {
    const hit = kind => { hits.push({ line: i + 1, kind }); if (/^(token|value|random|bearer|header|query|cli|quoted|word|phrase)$/.test(kind)) sp.add(i); return R(kind); };
    if (/^\s*`{3}/.test(line)) fence = !fence;
    if (pre.has(i)) return line.replace(new RegExp(LEAD.source + '(.*\\S)'), (m, p) => p + hit(pre.get(i)));
    if (carry && /^\s*`?\S{4,}`?\s*$/.test(line) && !/:\s*$/.test(line)) { carry = false; return line.replace(/\S+/, () => hit('value')); }
    carry = false; const kt = []; line = protect(line, kt); const xs = xend; xend = new RegExp('\\b(' + TW + ')s?\\s*[.!?]\\s*$', 'i').test(line);
    line = line.replace(SHAPES, () => hit('token'))
      .replace(/\b(Bearer\s+)[\w.~+\/-]{16,}=*/gi, (m, b) => b + hit('bearer'))
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@\/]+:[^\s@\/]+@/gi, (m, s) => s + hit('url-credentials') + '@')
      .replace(/https?:\/\/(hooks\.slack\.com\/services|discord(app)?\.com\/api\/webhooks)\/\S+/gi, () => hit('webhook'))
      .replace(/([?&](access_token|token|key|api_key|apikey|secret|sig|signature|password|auth)=)[^&#\s)\]>"'`]+/gi, (m, p) => p + hit('query'))
      .replace(/(?<!\S)(--?u(?:ser)?[ =]['"]?[^\s:'"]+:)([^\s'"@]+)/g, (m, f, p) => /^\$|^\d+$/.test(p) ? m : f + hit('cli')) // curl -u user:pass
      .replace(/(?<!\S)(--?(?:password|passwd|pass|token|api-?key|secret|auth-token|access-token)[ =]['"]?)([^\s'"]+)/gi, (m, f, v) => keep(v) || v.startsWith('$') ? m : f + hit('cli'))
      .replace(/\b((?:proxy-)?authorization|x-[\w-]*(?:key|token|secret))(\s*:\s*(?:(?:basic|bearer|token|digest)\s+)?)([^\s'"`]{6,})/gi, (m, h, s, v) => keep(v) || v.startsWith('$') ? m : h + s + hit('header'));
    line = grouped(line, hit);
    if (/\b(apps?|pass\w*|gmail|google|apple|keys?|tokens?|secrets?|codes?|pw|log-?in)\b/i.test(line)) line = line.replace(/(?<![\w.\/+=-])[A-Za-z0-9]{4}( [A-Za-z0-9]{4}){3,}(?![\w-])/g, m => { const w = m.toLowerCase().split(' '); // 4x4 app password, any case
      return w.some(x => FW.test(x)) || w.every(x => /^[a-z]+$/.test(x) && /[aeiouy]/.test(x) && !/[^aeiouy]{3}/.test(x)) ? m : hit('apppw'); });
    line = line.replace(/(^|\s)(\S+) (?=\[REDACTED:(grouped|apppw)\])/g, (m, s, t) => wordTok(t) ? m : s); // the run starts at its leading token
    line = line.replace(ASSIGN, (m, pre, q, key, val, off) => { // whole key names only: author, keyboard, max_tokens pass
      const k = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      if (!SECRET_KEY.test(k)) return m;
      const b = val === undefined ? '' : line.slice(0, off) + m.slice(0, m.length - val.length); // `export VAR=` then prose: no value
      if (val !== undefined && (/[^\s:=]=\**[ \t]+$/.test(b) && !/\d/.test(val) || val[0] === '`' && b.split('`').length % 2 === 0)) return m;
      if (val === undefined) { if (/[:=]\**\s*$/.test(line)) carry = true; return m; }
      const qv = /^["'`]/.test(val) ? val[0] : '';
      const inner = (qv ? val.slice(1, -1) : val.replace(/\s+#.*$/, '')).trim();
      if (keep(inner)) return m;
      return m.slice(0, m.length - val.length) + qv + hit('value') + qv + (qv ? '' : val.match(/\s*$/)[0]);
    });
    if (WORD.test(line.replace(NOTSEC, ''))) { // keyword in prose: secret-looking values only
      line = line.replace(/(["'`])([^\s"'`]{6,})\1/g, (m, q, v) => looksSecret(v) ? q + hit('quoted') + q : m)
        .replace(/(^|\s)([^\s"'`|]{8,}?)([.,;:)]?(?=\s|$))/g, (m, a, v, t) => looksSecret(v) ? a + hit('word') + t : m);
      if (/\b(password|passwd|passcode|passphrase|token|secret|pin)\**\s*:\**\s*$/i.test(line)) carry = true;
    }
    line = line.replace(PHRASE, (m, w, gap, conn, q, v, off) => { // "the word is X", "padlock is 7731"
      const [, val, tail] = v.match(/^(.*?)([.,;:)!?#]*)$/);
      const head = m.slice(0, m.length - v.length - q.length);
      if (!val || val.startsWith('[') || ENVNAME.test(val) || val.includes('/') || STOP.test(val) || yearKeep(line, off + m.length - v.length - q.length, val) || /^with$/i.test(conn) && !risky(val)) return m;
      if (!/\b(word|pass\w*)(\s+is|:)\s*["'`]?$/i.test(head) && !(/\d/.test(val) && val.length >= 3) && !(/[a-z]/.test(val) && /[A-Z]/.test(val))) return m;
      return head + hit('phrase') + tail + q;
    });
    line = ((xs ? 'word. ' : '') + line).replace(XS, (m, w, q, v) => { const [, val, tail] = v.match(/^(.*?)([.,;:)!?]*)$/);
      return !val || STOP.test(val) || val.startsWith('[') || /^(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(val) && !/\d/.test(val) ||
        !(/\d/.test(val) || q || /^(word|code|pass\w*|pin|combo|combination)$/i.test(w) && /^[A-Z]/.test(val)) ? m : m.slice(0, m.length - v.length - q.length) + hit('phrase') + tail + q; }).slice(xs ? 6 : 0);
    if (/\b(name|birthday|initials|surname|postcode)\b[^.;]{0,40}?\b(then|plus|followed by|and)\s+\d{1,6}\b/i.test(line)) // "the dog's name then 77, so Rex77"
      line = line.replace(/(\bso\b[:,]?\s*[`"']?)([^\s`"',;]*\d[^\s`"',;]*?)(?=[.`"']?(\s|$|[,;]))/gi, (m, p) => p + hit('phrase'));
    if (new RegExp('\\b' + LOCKW + '\\b', 'i').test(line)) line = line.replace(NUMRUN, () => hit('code'));
    if (/\b(alarm|keypad|lock(-up|\w*)|padlock|safe|gate|door)(s|ed)?\b/i.test(line)) // bare 3-8 digit codes near lock words
      line = line.replace(/(?<![\w\-:.\/#])\d{3,8}(?![\w\-:.\/])/g, (d, off) => keepNum(line, off, d) ? d : hit('code'));
    line = line.replace(SEEDRUN, (m, p, run) => run.split(/[ ,]+/).some(w => FW.test(w)) ? m : p + hit('seed'));
    if (/\b(mysql\w*|mariadb|sshpass|smbclient|mongo\w*)\b|(?<!\S)-u\s/.test(line)) // here -p takes a password, not a port
      line = line.replace(/(?<!\S)(-p ?['"]?)([^\s'"-][^\s'"]*)/g, (m, f, v) => /^\$|^\d+(:\d+)?$/.test(v) ? m : f + hit('cli'));
    if (/\b(log-?in|portal|account|user(name)?|creds?|credentials|sign[- ]?in|password|pw)\b/i.test(line)) // "user / pass" pairs
      line = line.replace(/(\S+)(\s+\/\s+)([^\s`"']+)/g, (m, a, s, v) => STOP.test(v) || v.startsWith('[') || (/^[a-z]+$/.test(a + v) && !/[:`]/.test(line)) ? m : a + s + hit('pair'));
    const sw = line.match(/\b(wi-?fi|pass(word|wd|code|phrase)|login|portal|pw)\b/i); // slug passwords after a trigger: blue-fox-4471
    if (sw) line = line.slice(0, sw.index) + line.slice(sw.index).replace(/(?<![\w\/.-])[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+(?![\w\/-])/g, t =>
      SLUG.test(t) && (t.match(/[a-z]{2,}/gi) || []).length >= 2 && (/\d/.test(t) || t.split(/[-_.]/).length >= 3) && !DATEISH.test(t) && !/\.[a-z]{1,4}$/i.test(t) ? hit('slug') : t);
    line = line.replace(/[A-Za-z0-9+=_-]{20,}/g, m => /\d/.test(m) && /[A-Za-z]/.test(m) && !ENVNAME.test(m) && !SLUG.test(m) && H(m) > 3.5 ? hit('random') : m);
    if (!fence && TRIG.test(line) && !NOTSEC.test(line) && !/^\s*`{3}/.test(line)) // residual gate
      line = line.replace(/[^\s"'`()\[\]{},;]+/g, (t, off) => { const s = t.replace(/[.,:!?#]+$/, ''); return risky(s) && !keepNum(line, off, s) ? hit('maybe') + t.slice(s.length) : t; });
    return line.replace(/\uE000(.)\uE000/g, (m, c) => kt[c.charCodeAt(0) - 0xE100]);
  });
  const lone = j => { const m = (lines[j] || '').match(/^(\s*(?:[-*+]\s+|\d{1,2}[.)]\s*)?[`"']?)([\w+\/=-]{4,})([`"']?[.,;]?\s*)$/); // lone mixed fragment
    if (m && /\d/.test(m[2]) && /[A-Za-z]/.test(m[2]) && !SLUG.test(m[2]) && !DATEISH.test(m[2]) && !ENVNAME.test(m[2])) { hits.push({ line: j + 1, kind: 'split' }); lines[j] = m[1] + R('split') + m[3]; } };
  lines.forEach((l, i) => { if (sp.has(i)) { let j = i + 1; while (j < lines.length && !lines[j].trim()) j++; lone(j); } // key split over lines
    if (/\b(join|(two|three|four|five|\d) (lines|parts)|second half|continued|wrapped)\b/i.test(L[i])) for (let j = Math.max(0, i - 2); j <= i + 4; j++) if (j !== i) lone(j);
    if (l.includes('[REDACTED') && /\b(half|halves|parts?|rest|continued|continues)\b/i.test(L[i])) { let j = i + 1; while (j < lines.length && !lines[j].trim()) j++; lone(j); } }); // hit beside "rest": fragment on the next line
  const JOIN = /(?:[-_+\\\/…]|\.\.\.)\s*$/, ENDHIT = /\[REDACTED:[\w-]+\][`"'.,;:)\\…-]*\s*$/; // a value that ends its line and goes on below
  const ftok = (s, any) => s.length >= 2 && !s.includes('REDACTED') && !STOP.test(s) && !FW.test(s) && !DATEISH.test(s) && !ENVNAME.test(s) && !/^\d+(st|nd|rd|th)$/i.test(s) &&
    (any || !/^(19|20)\d\d$/.test(s) && (/\d/.test(s) || /[a-z][A-Z]/.test(s) && !/^([A-Z]?[a-z]+)+$/.test(s) || /^[A-Za-z]{3,}$/.test(s) && !/[aeiouy]/i.test(s)));
  lines.forEach((x, i) => { const l = lines[i]; if (!l.includes('[REDACTED') || !(ENDHIT.test(l) || JOIN.test(L[i]))) return;
    let j = i + 1; if (j < lines.length && !lines[j].trim()) j++; if (j >= lines.length) return;
    const m = protect(lines[j], []).match(/^(\s*(?:[-*+>]\s+|\d{1,2}[.)]\s+)?[`"']?)([^\s`"',;]+)/); if (!m || m[2].includes('\uE000')) return; // phones and refs stay
    const s = m[2].replace(/[.:!?)]+$/, ''); if (!ftok(s, JOIN.test(L[i]))) return;
    hits.push({ line: j + 1, kind: 'cont' }); lines[j] = m[1] + R('cont') + lines[j].slice(m[1].length + s.length); });
  const frag = s => /^\s*[`"']?[\w+\/=-]{3,}[`"']?[.,;]?\s*$/.test(s) && (/\d/.test(s) || /[a-z][A-Z]/.test(s)) && !s.includes('REDACTED');
  lines.forEach((l, i) => { const m = l.match(/(?:^|[\s`"':=])((?:sk-|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|glpat-|hf_)[\w-]*)[`"']?\s*$/); let n = 0; // known prefix, key wrapped over 2-4 lines
    if (m) while (n < 3 && frag(lines[i + n + 1] || '')) n++;
    if (n) for (let k = i; k <= i + n; k++) { hits.push({ line: k + 1, kind: 'split' }); lines[k] = k === i ? l.replace(m[1], R('split')) : lines[k].replace(/[\w+\/=-]{3,}/, R('split')); } });
  const SECL = /\b(pass\w*|pwd?|pins?|codes?|tokens?|secrets?|log-?ins?|sign[- ]?in|recovery|backup|wi-?fi|phrase|credentials?)\b|\b(api|app|access|secret|private|ssh|licen[cs]e|stripe)\s+keys?\b|\bkeys?:?\s*$/i; // secret labels
  const cell = s => /^[\w+\/=-]{4,12}$/.test(s) && (/\d/.test(s) && /[A-Za-z]/.test(s) || /[a-z][A-Z]/.test(s) && !/^([A-Z]?[a-z]{2,})+$/.test(s)) && !DATEISH.test(s) && !/^(\d+([.,]\d+)?[A-Za-z]{1,3}|[A-Za-z]{1,2}\d{1,3})$/.test(s) && !keepNum(s, 0, s);
  lines.forEach((l, i) => { const m = l.match(/^(\s*\d{1,2}[.)]\s+(?:[^:]{0,40}:\s+)?[\x60"']?)([^\s\x60"']+?)([\x60"']?[.,;]?\s*)$/); // a list step that is a lone value, near a secret label
    if (m && risky(m[2]) && !keepNum(l, m[1].length, m[2]) && L.slice(Math.max(0, i - 6), i + 1).some(x => SECL.test(x))) { hits.push({ line: i + 1, kind: 'step' }); lines[i] = m[1] + R('step') + m[3]; }
    if (/^\s*\|.*\|\s*$/.test(l) && l.split('|').slice(1, -1).filter(s => cell(s.trim())).length >= 3) { hits.push({ line: i + 1, kind: 'table' }); // a row of key fragments goes whole
      lines[i] = l.replace(/[^|]+(?=\|)/g, (s, off) => off && s.trim() ? ' ' + R('table') + ' ' : s); } });
  return { text: lines.join('\n'), hits };
}
const BROAD = /\b(pass\w*|pw|pwd|pins?|codes?|combo|combination|keys?|log-?ins?|log in|sign[- ]?in|portal|account|wallet|seed|recovery|backup|wi-?fi|lock\w*|alarm|keypad|safe|secrets?|tokens?|phrase|mnemonic|words?)\b/i;
const flagged = text => text.split('\n').filter(l => BROAD.test(l)).length; // step 6: return this count, nothing else
const unsafe = s => { const u = protect(s, []); return scrub(s).hits.length > 0 || BROAD.test(u) && (u.match(/[^\s"'`()\[\]{},;]+/g) || []).some(t => { const x = t.replace(/[.,:!?#]+$/, ''); return risky(x) && !/^(19|20)\d\d$/.test(x); }); }; // years alone pass; scrub() still catches one beside a lock word
const strs = v => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.entries(v).flat().flatMap(strs) : [];
const sift = o => { let dropped = 0; const out = {}, held = []; // drop model output items that still trip a check; held: cites for heldCheck()
  for (const [k, v] of Object.entries(o || {})) { const a = (Array.isArray(v) ? v : [v]).filter(x => { const bad = strs(x).some(unsafe); dropped += bad;
    if ((bad || /\(withheld\)/i.test(x?.text)) && /^[\w.\/ -]+:\d+([-–]\d+)?$/.test(x?.cite)) held.push(x.cite); return !bad; }); out[k] = Array.isArray(v) ? a : a[0] ?? null; }
  return { out, dropped, held }; };
const citeLines = c => { const m = c.match(/^(.+):(\d+)(?:[-–](\d+))?$/); return m ? Array.from({ length: Math.min(+(m[3] || m[2]) - m[2], 20) + 1 }, (_, i) => [m[1], +m[2] + i]) : []; };
async function heldCheck(held, read, root = '') { // cites are relative to D; root: the drop's D path; read: async path => scrubbed source text
  const out = [], seen = new Set(), ind = l => l.match(/^\s*/)[0].length, item = l => /^\s*([-*+]|\d{1,2}[.)])\s/.test(l);
  for (const c of held) { const r = citeLines(c); if (!r.length) continue; const p = r[0][0]; let T; try { T = (await read(root + p))?.split('\n'); } catch (e) { T = null; } if (!T) continue;
    const ns = r.map(x => x[1]), end = ns[ns.length - 1], lv = item(T[ns[0] - 1] || '') ? ind(T[ns[0] - 1]) : -1; // block: to a blank line, heading, or list item at the cite's level; 12 lines at most
    for (let n = end + 1; n <= Math.min(T.length, end + 12) && T[n - 1].trim() && !/^\s*#/.test(T[n - 1]) && !(item(T[n - 1]) && ind(T[n - 1]) <= lv); n++) ns.push(n);
    for (const n of ns) { const l = T[n - 1]; if (l == null || !l.trim() || seen.has(p + ':' + n)) continue; seen.add(p + ':' + n); if (!l.includes('[REDACTED')) out.push(p + ':' + n); } }
  return out; } // 'path:line' for each non-empty block line with no marker; write it to risk.json as is. pageFilter() treats page lines citing them strictly
async function citeCheck(text, read, root = '') { // cites in a page that miss: no such file, past its end, or a blank line. Returns 'path:line' strings
  const bad = new Set(), F = {};
  for (const m of text.matchAll(CITE)) { const p = m[1]; if (!(p in F)) { try { F[p] = (await read(root + p))?.split('\n') ?? null; } catch (e) { F[p] = null; } }
    for (let n = +m[2]; n <= +(m[3] || m[2]); n++) if (!F[p] || !(F[p][n - 1] || '').trim()) bad.add(p + ':' + n); }
  return [...bad]; }
const reply = r => { let s = typeof r === 'string' ? r : r?.text ?? r?.content ?? r?.output ?? ''; if (Array.isArray(s)) s = s.map(x => x?.text || '').join('');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); }; // model_invoke reply to JSON; on error return e.name only

const CITE = /([\w.\/-]+\.[A-Za-z]\w{0,4}):(\d+)(?:[-–](\d+))?(?:\s+in the drop)?/g; // MEMORY.md:12 in the drop
function pageFilter(text, risk = new Set(), mark) { // a generated page -> { text, dropped: [{ line, cites }] }. risk: Set or array of 'path:line' from heldCheck() (risk.json).
  risk = risk instanceof Set ? risk : new Set(risk || []);
  // A line goes if it trips scrub() or unsafe() with its cites taken out, or if it cites a risk line and holds any risky token.
  // mark(cites, n): replacement line (staged skills); without it the line is removed.
  const L = text.split('\n'), M = L.map(l => [...l.matchAll(CITE)]), bare = L.map(l => l.replace(CITE, ''));
  const hit = new Set(scrub(bare.join('\n')).hits.map(h => h.line - 1)), out = [], dropped = [];
  L.forEach((l, i) => { const b = bare[i], shown = [...new Set(M[i].map(m => m[1] + ':' + m[2] + (m[3] ? '-' + m[3] : '')))];
    const lines = M[i].flatMap(m => Array.from({ length: Math.min(+(m[3] || m[2]) - m[2], 20) + 1 }, (_, k) => m[1] + ':' + (+m[2] + k)));
    const strict = lines.some(c => risk.has(c)) && (protect(b, []).match(/[^\s"'`()\[\]{},;|]+/g) || []).some(t => { const s = t.replace(/[.,:!?#]+$/, ''); return risky(s) && !/^(19|20)\d\d$/.test(s); });
    if (!(hit.has(i) || unsafe(b) || strict)) return out.push(l);
    dropped.push({ line: i + 1, cites: shown }); if (mark) out.push(l.match(/^\s*/)[0] + mark(shown, i + 1)); });
  return { text: out.join('\n'), dropped };
}
const withheldMark = cites => '[withheld: check your original' + (cites.length ? ', ' + cites.join(', ') : '') + ']'; // staged skills
module.exports = { scrub, sift, flagged, unsafe, asText, reply, heldCheck, citeCheck, pageFilter, withheldMark, risky, protect, keepNum, R };
