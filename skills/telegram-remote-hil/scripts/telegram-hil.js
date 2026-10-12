// Revision 3 candidate (Revision 2 + corrections F2/F3). Owner must configure ID, protect AND lock the ledger, review and authorize.
import { randomUUID, createHash } from 'crypto';
const OWNER_ID = 'REPLACE_WITH_PRINCIPAL_TELEGRAM_USER_ID';
const TABLE = 'local_telegram_hil_requests';
const TTL_MS = 300000;
// Published ledger DDL. The live table must match it exactly (whitespace-normalized); anything else fails closed.
const LEDGER_DDL = `CREATE TABLE ${TABLE} (
 task_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, task_hash TEXT NOT NULL,
 preview_hash TEXT NOT NULL, subject TEXT NOT NULL, recipient TEXT NOT NULL,
 issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
 outbox_id TEXT UNIQUE
)`;
// Any of these owner locks covers security.table_protections.<TABLE> (prefix locks) against ordinary edits.
const GUARD_LOCKS = ['security','security.table_protections',`security.table_protections.${TABLE}`];
const hash = value => createHash('sha256').update(value).digest('hex');
function parse(v) { if(typeof v !== 'string') return v; try{return JSON.parse(v)}catch{return null} }
function rows(v) { const p=parse(v); if(!Array.isArray(p))throw Error('Expected query rows');return p }
async function query(sql,params=[]) {return rows(await adf.db_query({sql,params}))}
async function write(sql,params=[]) {const r=await adf.db_execute({sql,params});if(typeof r==='string' && /^(SQL error:|Cannot |Only )/.test(r))throw Error(r);if(r?.error)throw Error(r.error);return r}
const norm=sql=>String(sql??'').replace(/\s+/g,' ').trim();
async function guard() {
  if(!/^[1-9][0-9]*$/.test(OWNER_ID))throw Error('Configure verified principal Telegram user ID');
  const c=parse(await adf.sys_get_config({section:'config'}));
  if(c?.security?.table_protections?.[TABLE]!=='authorized')throw Error('Owner must protect gateway ledger as authorized');
  const locks=Array.isArray(c?.locked_fields)?c.locked_fields:[];
  if(!GUARD_LOCKS.some(f=>locks.includes(f)))throw Error('Owner must lock security.table_protections');
  // Every schema object tied to the ledger, in main AND temp (a temp object would shadow it), plus any trigger/view mentioning it.
  const objs=await query(`SELECT 'main' AS db,type,name,tbl_name,sql FROM main.sqlite_master WHERE lower(tbl_name)=lower(?) OR lower(name)=lower(?) OR (type IN ('trigger','view') AND sql LIKE ?)
    UNION ALL SELECT 'temp',type,name,tbl_name,sql FROM temp.sqlite_master WHERE lower(tbl_name)=lower(?) OR lower(name)=lower(?) OR (type IN ('trigger','view') AND sql LIKE ?)`,
    [TABLE,TABLE,`%${TABLE}%`,TABLE,TABLE,`%${TABLE}%`]);
  const got=objs.map(o=>`${o.db}|${o.type}|${o.name}|${o.type==='table'?norm(o.sql):o.sql??''}`).sort();
  const want=[`main|table|${TABLE}|${norm(LEDGER_DDL)}`,...[1,2,3].map(i=>`main|index|sqlite_autoindex_${TABLE}_${i}|`)].sort();
  if(JSON.stringify(got)!==JSON.stringify(want))throw Error('Gateway ledger schema mismatch or untrusted trigger/view/index/temp object');
  return `telegram:${OWNER_ID}`;
}
const taskHash=t=>hash(JSON.stringify([t.id,t.tool,t.args,t.approval_meta??null,t.origin,t.created_at,t.requires_authorization,t.executor_managed]));
const pending=t=>t?.status==='pending_approval' && Number(t.requires_authorization)===1;
// Only ordinary restricted-tool approvals go remote. Protection overrides (reason 'protection'), missing or
// unparseable metadata, and unknown reasons are Studio-only: never forwarded, resolved, or swept here.
const remoteEligible=t=>parse(t?.approval_meta)?.reason==='restricted';
async function task(id){return (await query('SELECT * FROM adf_tasks WHERE id = ? LIMIT 1',[id]))[0]}
async function request(id){return (await query(`SELECT * FROM ${TABLE} WHERE task_id = ? LIMIT 1`,[id]))[0]}
async function resolve(id,action,reason){const r=await adf.task_resolve({task_id:id,action,...(reason?{reason}:{})});if(r?.error)throw Error(r.error);if(typeof r==='string' && /error|INVALID_STATE|REQUIRES_AUTHORIZED/i.test(r))throw Error(r);return r}

export async function onTaskCreate(event) {
  const recipient=await guard();
  const id=event?.data?.task?.id;
  if(typeof id!=='string')return {skipped:'missing_task_id'};
  const t=await task(id);
  if(!pending(t)||Date.now()>=Number(t.created_at)+TTL_MS)return {skipped:'not_fresh_pending_hil'};
  if(!remoteEligible(t))return {skipped:'studio_only_approval'};
  const token=randomUUID();
  // Safe-field preview: arbitrary args/commands/secrets stay in Studio. Hash binds full input.
  const preview=['Human approval needed',`Task: ${t.id}`,`Tool: ${t.tool}`,`Request fingerprint: ${taskHash(t)}`,
    'Open this task in Studio and inspect the complete tool input before deciding.',
    'Reply directly to THIS message with yes or no. If you cannot inspect the task, reply no.',
    'Expires five minutes after task creation. Approval is for this request only.',`Gateway reference: ${token}`].join('\n');
  const subject=`telegram-hil:${id}:${token}`;
  // Owner-protected ledger; PK claim is atomic. No subject-only dedupe.
  await write(`INSERT INTO ${TABLE} (task_id,token,task_hash,preview_hash,subject,recipient,issued_at,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING`,[id,token,taskHash(t),hash(preview),subject,recipient,Date.now(),Number(t.created_at)+TTL_MS,'dispatching']);
  let record=await request(id);
  if(record?.token!==token)return {skipped:'already_claimed'};
  // msg_send currently returns no outbox ID. Bind only a unique exact full-message match.
  // Token alone is NOT authentication. Its authoritative binding is the protected ledger.
  await adf.msg_send({recipient,subject,content:preview});
  const sent=await query('SELECT * FROM adf_outbox WHERE subject = ? AND "to" = ? AND content = ? AND created_at >= ?',[subject,recipient,preview,record.issued_at]);
  if(sent.length!==1 || sent[0].status!=='delivered')return {skipped:'ambiguous_or_unconfirmed_delivery'};
  await write(`UPDATE ${TABLE} SET outbox_id = ?,state = ? WHERE task_id = ? AND token = ? AND state = ?`,[sent[0].id,'ready',id,token,'dispatching']);
  return {notified:id};
}

export async function onReply(event) {
  const recipient=await guard();
  const hint=event?.data?.message??event?.message??event;
  if(typeof hint?.id!=='string')return {skipped:'missing_inbox_id'};
  const msg=(await query('SELECT * FROM adf_inbox WHERE id = ? LIMIT 1',[hint.id]))[0];
  const ctx=parse(msg?.source_context);
  if(!msg||msg.source!=='telegram'||msg.from!==recipient||String(ctx?.chat_id)!==OWNER_ID||ctx?.chat_type!=='private')return {skipped:'not_principal_private_dm'};
  const text=String(msg.content??'').trim().toLowerCase();
  if(!/^(y|yes|approve|n|no|deny)$/.test(text)||!msg.parent_id)return {skipped:'not_threaded_verdict'};
  const records=await query(`SELECT * FROM ${TABLE} WHERE outbox_id = ? AND state = ?`,[msg.parent_id,'ready']);
  if(records.length!==1)return {skipped:'not_gateway_issued_request'};
  const r=records[0];
  const sent=(await query('SELECT * FROM adf_outbox WHERE id = ? LIMIT 1',[r.outbox_id]))[0];
  if(!sent||sent.to!==recipient||sent.subject!==r.subject||hash(sent.content)!==r.preview_hash||Number(msg.received_at)<Number(sent.created_at))return {skipped:'request_binding_mismatch'};
  const t=await task(r.task_id);
  if(!pending(t))return {skipped:'not_pending'};
  if(taskHash(t)!==r.task_hash)return {skipped:'task_changed'};
  if(!remoteEligible(t))return {skipped:'studio_only_approval'};
  const expired=Date.now()>=r.expires_at;
  const action=!expired && /^(y|yes|approve)$/.test(text)?'approve':'deny';
  // Atomic runtime resolution required: installed build must synchronously transition
  // pending -> running/denied before yielding. See skill's deployment gate.
  await resolve(t.id,action,action==='deny'?(expired?'Telegram approval expired':'Principal denied via Telegram'):undefined);
  await write(`UPDATE ${TABLE} SET state = ? WHERE task_id = ? AND state = ?`,[action,t.id,'ready']);
  await adf.msg_send({parent_id:msg.id,content:action==='approve'?'Approval recorded; execution completion is a separate result.':'Request denied.'});
  return {task_id:t.id,action};
}

export async function onTimeout() {
  await guard();
  const tasks=await query('SELECT * FROM adf_tasks WHERE status = ? AND requires_authorization = 1 AND created_at <= ?',['pending_approval',Date.now()-TTL_MS]);
  let denied=0;
  for(const t of tasks){const current=await task(t.id);if(!pending(current)||!remoteEligible(current)||Date.now()<Number(current.created_at)+TTL_MS)continue;await resolve(current.id,'deny','Telegram approval timed out');denied++;}
  return {denied};
}
