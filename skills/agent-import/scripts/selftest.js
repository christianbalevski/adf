// agent-import self-test. Load scrub.js as S first (see its header), then:
//   const run = await load('<skill folder>/scripts/selftest.js'); return await run(S);
// T: a synthetic string and the value(s) that must disappear. K: must come back unchanged. K2 (placeholders, phones, refs): unchanged and not unsafe().
// E: exact output. Then flagged(), sift(), reply(), the PEM line count, heldCheck() blocks, and pageFilter() on mind pages and staged skills.
// Every T string also goes through pageFilter() (its values must go), and every K2 string with a cite must survive it.
module.exports = async S => { const { scrub, sift, flagged, unsafe, asText, reply, heldCheck, citeCheck, pageFilter, withheldMark } = S;
const S12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const T = [['password: hunter2xyz', 'hunter2xyz'], ['ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5', 'aB3dE5'], ['GH_TOKEN=abc123XYZ789', 'abc123'],
  ['The wifi password is `Garden2024!`', 'Garden2024'], ['db: postgres://admin:s3cret@db.local/app', 's3cret'],
  ['FAKE note: the word is marmalade', 'marmalade'], ['FAKE: back door code is 4471-blue', '4471'], ['FAKE: the yard padlock is 7731', '7731'],
  ['FAKE alarm panel in the hall takes 1234 then #', '1234'], ['FAKE: the locker by the gym opens with 2468.', '2468'],
  ['FAKE seed phrase: ' + S12, 'absorb'], ['FAKE recovery words:\n' + S12, 'absurd'],
  ['FAKE gate (ask Des) Zq9fake', 'Zq9fake'], ['FAKE wifi: TulipFAKE', 'TulipFAKE'], ['FAKE memorable word: marigold', 'marigold'],
  ['FAKE: curl -u maria:Tulip9fake https://example.org/api', 'Tulip9fake'], ['FAKE: mysql -u root -p Hunter9fake garden', 'Hunter9fake'],
  ['FAKE: rota login --password Tulip9fake', 'Tulip9fake'], ['FAKE: rota sync --token abcFAKE123', 'abcFAKE123'],
  ["FAKE: curl -H 'Authorization: Basic ZmFrZTpmYWtl' https://example.org", 'ZmFrZTpmYWtl'], ['FAKE portal `maria.k / Tulip!fake`', 'Tulip!fake'],
  ['FAKE login: dez / sunflowerfake', 'sunflowerfake'], ['FAKE wifi is blue-fox-4471, so: blue-fox-4471.', 'blue-fox-4471'],
  ['FAKE password reminder: mossy-otter-lantern', 'mossy-otter-lantern'], ['FAKE alarm code 1987', '1987'], ['FAKE keypad: 2024', '2024'],
  ['FAKE Strawberry: 12 words for the old wallet: ' + S12, 'absorb'],
  ['FAKE notes:\nzoo wrist yellow young zero zone vote wagon wait walk wall wander', 'wagon'],
  ['FAKE\nabandon ability able about\nabove absent absorb abstract\nabsurd abuse access accident', 'absorb'],
  ['FAKE\n' + S12.split(' ').map((w, i) => i + 1 + '. ' + w).join('\n'), 'absorb'],
  ['FAKE 24: ' + S12 + ' ' + S12, 'absorb'],
  ['FAKE recovery codes\na1b2c-3d4e5\nf6g7h-8i9j0\nk1l2m-3n4o5', '8i9j0'], ['FAKE\n4f7a9c2e1b\n8d3e6f0a2c\n1b9e7d4a6f', '8d3e6f0a2c'],
  ['FAKE backup: 1234 5678  2468 1357  9753 8642  1122 3344', '2468'], ['FAKE: the lockup at Junction 15 opens with LK47fake then hash', 'LK47fake'],
  ['FAKE lockbox 4821 by the shed', '4821'], ['FAKE the lock-up takes 3391#', '3391'], ['FAKE key in two parts:\n`sk-FAKEab12cd34ef56gh78ij`\n`9c8b7a6d5e`', '9c8b7a6d5e'],
  ['FAKE api_key: Zx9fakeQw8fakeEr7\n\n4d5e6fake7', '4d5e6fake7'], ['FAKE: join these\n- `k3y9part`', 'k3y9part'], ['FAKE second half:\n\nb7fake22', 'b7fake22'],
  ['FAKE backup codes: QX7K-22MF and PL9D-44TR', 'PL9D-44TR'], ['FAKE: the locker by the pool opens on LK-4471-ZQ', 'LK-4471-ZQ'],
  ['FAKE: Log in to the rota dashboard with Dash9fake', 'Dash9fake'], ['FAKE: sign in with "Sign7fake" today', 'Sign7fake'],
  ["FAKE reading site: just the dog's name then 77, so Rufusfake77, easy", 'Rufusfake77'], ["FAKE: we agreed a safe word. It's Pomegranate.", 'Pomegranate'],
  ['FAKE: the trip has a safe word.\nThat is Clementine.', 'Clementine'], ['FAKE: keypad by the staff room is four seven one one nine', 'seven one one'],
  ['FAKE alarm code: oh nine two four', 'nine two four'], ['FAKE OpenRouter key, three lines:\nsk-or-v1-ab12\ncd34ef56gh78\nij90kl12', 'ij90kl12'],
  ['FAKE note\n`sk-or-v1-9f`\n`7d6c5b4a3f2e`\n`1a2b`', '7d6c5b4a3f2e'], ['FAKE\nxoxb-12\n34fake56\n7Zq', '7Zq'],
  ['FAKE Mapbox key Xk7p Qm2r fake Lt9w Bz4n Hd6s', 'Qm2r'], ['FAKE tiles: mqzt 7rk2 pwvx 9bnl hjsd fake', '9bnl'], ['FAKE mail app: wxqz plmr tvbk sdfg', 'tvbk'],
  ['FAKE gmail login abcd efgh ijkl mnop', 'ijkl'], ['FAKE calendar key 7Q XKQM PDRT ZWNB HJLS', ['7Q', 'XKQM', 'HJLS']],
  ['FAKE shop mail app password qx wxqz plmr tvbk sdfg', ['qx', 'wxqz', 'sdfg']], ['FAKE tiles key pk.Zq9 Xk7p Qm2r Lt9w Bz4n', ['pk.', 'Zq9', 'Bz4n']],
  ['FAKE router admin login:\n1. Open the panel\n2. User: admin\n3. Rq7fake2Lm', 'Rq7fake2Lm'], ['FAKE door app passcode steps\n1. Open the app\n2. Tap Unlock\n3. Enter: Wv4fake9', 'Wv4fake9'],
  ['FAKE Stripe key, split:\n| a | b | c |\n|---|---|---|\n| Xk7pQ2 | m9Rt4z | Lw82Hq |', ['Xk7pQ2', 'm9Rt4z', 'Lw82Hq']], ['FAKE\n| kQzRw | pXmTe | ZbQwN |', ['kQzRw', 'ZbQwN']], ['FAKE alarm 4471, rest on the next line\n\nQz82', 'Qz82'], ['FAKE safe 7731 (part one)\nRt5y', 'Rt5y'], ['FAKE lockbox code GHB-77314', 'GHB-77314'],
  ['FAKE door code: 4471\n8832 then hash', '8832'], ['FAKE portal password is Tulip9-\nfake22, then Enter', 'fake22'], ['FAKE safe word is Pome-\ngranate for the trip', 'granate'], // value goes on below its marker
  ['FAKE api_key: Zx9fakeQw8\n  Er7fakeLm2 (second line)', 'Er7fakeLm2'], ['FAKE wifi password: Garden24\n\nQz82 is the rest', 'Qz82'],
  ['FAKE\n-----BEGIN PRIVATE KEY-----\nMIIfakeAbc123\nQz9fake\n-----END PRIVATE KEY-----\nafter', ['MIIfakeAbc123', 'Qz9fake']]];
const K = ['in 2026', 'since 1998', 'Both thefts in 2026, after the shed lock broke', 'The back door lock was replaced in 2026',
  'Gate code changed since 1998', 'The wifi password was set up for her in 2026', 'Plan for 2026: lock in the venue',
  'the account has read / write access', 'mkdir -p logs', 'sudo -u postgres psql -p 5432', 'docker run -u 1000:1000 -p 8080:80 app',
  'curl -u $ROTA_USER:$ROTA_PASS https://example.org', 'gh auth login --token $GH_TOKEN', 'Check the wi-fi router and the check-in sheet',
  'Remember to water the tomatoes before you leave for work each morning',
  '- prune apple trees\n- order seed potatoes\n- fix shed door\n- call des back', 'requires: { env: ["GH_TOKEN"] }', 'primaryEnv: GH_TOKEN',
  'pin the version', 'author: Jane Keyes', 'metadata: {"openclaw":{"requires":{"bins":["gh"],"env":["GH_TOKEN"]},"primaryEnv":"GH_TOKEN"}}',
  'key dates', 'token ring', 'the author is Jane Keyes', 'the code is in scripts/', 'GH_TOKEN', 'OPENAI_API_KEY', 'lock the door at 9',
  'port is 8080', 'Use claude-sonnet-4.5 for code', 'Door locks at 21:00', 'Seal 90185-10017 fits the lock',
  'Got 3AJ-24110-00, by the door', 'Bank card ends 4471, PIN is in the safe', 'OBD on port 35000 by the door', 'Concert: doors 19:00, BWV 147, hymn 547', 'Doors open 18:30; hymn 1023 after the lock-in',
  "Sheet ID 1AbCfake9xyzQ isn't secret, share it", "Fix the shed door. It's broken again.", 'Change the wifi password. It is due in May.',
  'Count in: one two three four', 'Log in with Google', 'keys start with sk-',
  'To change the wifi password:\n1. Unplug the router\n2. Wait: 30s\n3. Update: v2.4\n4. Log in at 192.168.1.1\n5. Done',
  '| Room | Piano | Pitch | Hours |\n|---|---|---|---|\n| Hall | Steinway B | A440 | 2.5 |\n| Studio2 | U3 | 442Hz | 1 |\n| Felt | 12 | 4.50 | 2026-10-19 |'];
const K2 = ['Authorization: Bearer <MAPBOX_TOKEN>', 'Add header `Authorization: Bearer <MAPBOX_ACCESS_TOKEN>` from the key', 'export MAPBOX_TOKEN=', // also pass unsafe()
  'Run `export MAPBOX_TOKEN=` before `node map.js`', 'export MAPBOX_TOKEN= then restart the app', 'Keep replies under a 120-word limit', 'Order 3AJ24 and 4BK22 from the shop',
  'The app goes live next week', 'Gate repairs: ring Hallam on 01539 733905', 'Locksmith: 01539 733905', 'Portal login for job GHB-77314 is in the binder', 'Account ref GHB-77314, call 07700 900123',
  'Train booking ref 7HQ2KD, coach C', 'Ferry booking 7HQ2KD for the 09:40', 'Hotel ref 7HQ2KD; door code comes by text'];
const E = [['FAKE [s](https://x.org/?token=Ab12fake) ok', 'FAKE [s](https://x.org/?token=[REDACTED:query]) ok'], ['FAKE <https://x.org/?key=Ab12fake>', 'FAKE <https://x.org/?key=[REDACTED:query]>']]; // exact output
E.push(['FAKE wifi password: Garden24\n2nd floor router, call 01539 733905\n\nThen lock the shed in 2026', 'FAKE wifi password: [REDACTED:value]\n2nd floor router, call 01539 733905\n\nThen lock the shed in 2026']);
E.push([asText({ mime_type: 'application/octet-stream', content: btoa('FAKE note') }), 'FAKE note']);
const bad = T.filter(([s, x]) => [].concat(x).some(v => scrub(s).text.includes(v))).map(([s]) => s).concat(K.filter(s => scrub(s).text !== s), K2.filter(s => scrub(s).text !== s || unsafe(s)), E.filter(([s, o]) => scrub(s).text !== o).map(([s]) => s));
if (flagged('the safe word\nlog in here') !== 2) bad.push('flagged()');
const M = sift({ soul: [{ text: 'Warm and brief', cite: 'SOUL.md:3' }], facts: [{ text: 'FAKE safe word is Pomegranate9', cite: 'SOUL.md:11' }, // mock model output
  { text: 'FAKE wallet Zq9fakeW7', cite: 'MEMORY.md:9' }, { text: 'Gate code is [REDACTED:phrase]', cite: 'MEMORY.md:4' }, { text: 'Choir meets Tuesdays at 19:00', cite: 'memory/2026-10-20.md:2' },
  { text: 'A gate code for the yard (withheld)', cite: 'MEMORY.md:6' }] });
if (M.dropped !== 2 || M.held.length !== 3 || M.out.facts.length !== 3 || M.out.soul.length !== 1 || /fake/i.test(JSON.stringify(M.out))) bad.push('sift()');
if (reply({ content: [{ text: 'x {"a": 1} y' }] }).a !== 1) bad.push('reply()');
const pem = scrub(T[T.length - 1][0]); if (pem.text.split('\n').length !== 6 || pem.hits.map(h => h.line).join() !== '2,3,4,5') bad.push('pem lines');
return (async () => {
  if ((await heldCheck(['a.md:1-2', 'a.md:3', 'b.md:1'], async p => ({ 'a.md': 'x\n[REDACTED:value] y\nFAKE' })[p])).length !== 2) bad.push('heldCheck()');
  const B = 'Shop\nFAKE Stripe key:\n  Qz9fakeA1\n  Wq8fakeB2\n\nFAKE Zz9fakeC3\n- FAKE wifi:\n  - Ab1fakeD4\n- FAKE Cd2fakeE5\nFAKE codes:\nHb3fakeF6\n## Next\nZx1fakeG7'; // label-line cites
  const hb = await heldCheck(['MEMORY.md:2', 'MEMORY.md:7', 'MEMORY.md:10'], async p => ({ 'agent-import-openclaw/MEMORY.md': B })[p], 'agent-import-openclaw/');
  if (hb.map(c => c.split(':')[1]).join() !== '2,3,4,7,8,10,11' || hb[0] !== 'MEMORY.md:2') bad.push('heldCheck() blocks'); // 'path:line' strings, as risk.json holds them
  const risk = new Set(hb); // page filter: a mind page written from that source
  const P = ['---', 'type: reference', 'sources: [agent-import-openclaw/MEMORY.md, deleted after import]', 'stale_after: 2026-12-01', '---', '# Shop',
    '- A Stripe key for the shop (withheld) (MEMORY.md:2 in the drop)', '- Card reader paired with Qz9fakeA1 (MEMORY.md:3 in the drop)',
    '- Hb3fakeF6 is the label on the till (MEMORY.md:11 in the drop)', '- Till code Zq7fakeW2 (MEMORY.md:20 in the drop)',
    '- Zz9fakeC3 is the van reg (MEMORY.md:6 in the drop)', '- Wifi password changed in 2026 (MEMORY.md:7 in the drop)',
    '- See [Ruth](adf-file://mind/user.md) and AGENTS.md:8 for the login rule (AGENTS.md:8 in the drop)', '- Backup codes are in the blue binder (MEMORY.md:10-11 in the drop)',
    'FAKE gmail app password abcd efgh ijkl mnop'];
  const pf = pageFilter(P.join('\n'), risk);
  if (pf.dropped.map(d => d.line).join() !== '8,9,10,15' || pf.dropped[2].cites.join() !== 'MEMORY.md:20' || pf.dropped[3].cites.length || /fake[AFW]|ijkl/.test(pf.text) ||
    !/fakeC3[\s\S]*2026[\s\S]*Ruth[\s\S]*binder/.test(pf.text) || pf.text.split('\n').length !== 11) bad.push('pageFilter()');
  const SK = ['---', 'name: tiles', 'requires:', '  tools: [sys_fetch]', '---', '## Steps', '1. Read the token in code.', '   curl -H "Authorization: Bearer <MAPBOX_TOKEN>" https://api.mapbox.com',
    '   curl -H "Authorization: Bearer Zx9fakeQw8fakeEr7Lm2" https://api.mapbox.com', 'Tile key Pk7fakeQ2 (SKILL.md:12 in the drop)']; // staged skill: lines marked, placeholders kept
  const sk = pageFilter(SK.join('\n'), new Set(), withheldMark), sl = sk.text.split('\n');
  if (sk.dropped.map(d => d.line).join() !== '9,10' || sl.length !== 10 || sl[7] !== SK[7] || sl[8] !== '   [withheld: check your original]' || sl[9] !== '[withheld: check your original, SKILL.md:12]') bad.push('pageFilter() skills');
  if (pageFilter(P.join('\n'), JSON.parse(JSON.stringify(hb))).dropped.map(d => d.line).join() !== '8,9,10,15') bad.push('pageFilter() risk.json array');
  const cc = await citeCheck('x (a.md:2 in the drop) y (a.md:9 in the drop), b.md:1 and a.md:1-3', async p => ({ 'r/a.md': 'l1\nl2\n\n' })[p], 'r/');
  if (cc.join() !== 'a.md:9,b.md:1,a.md:3') bad.push('citeCheck()');
  if (pageFilter(sk.text, new Set(), withheldMark).dropped.length || pageFilter(pf.text, risk).dropped.length) bad.push('pageFilter() idempotent');
  const PT = T.filter(([s, x]) => [].concat(x).some(v => pageFilter(s).text.includes(v))).map(([s]) => 'page: ' + s); // every T value is gone from a page
  const PK = K2.filter(s => { const o = pageFilter(s + ' (MEMORY.md:3 in the drop)'); return o.dropped.length || o.text !== s + ' (MEMORY.md:3 in the drop)'; }).map(s => 'page keep: ' + s);
  bad.push(...PT, ...PK);
  const n = { base: T.length + K.length + K2.length + E.length + 7, page: T.length + K2.length + 4 };
  return bad.length ? { selftest: 'FAIL', bad } : { selftest: 'pass', cases: n.base + n.page, ...n }; })();
};
