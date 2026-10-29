// Optional agent-space lambda. Uses only existing fs_read and loop_inject.
// The journal's content structure belongs to the agent, not to the runtime.
import { createHash } from 'crypto';

export async function refresh({ path }) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Provide the journal file path');
  const file = await adf.fs_read({ path });
  if (typeof file?.content !== 'string') throw new Error('Journal was not returned as text');
  const state = JSON.parse(file.content);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Expected a JSON object; inspect the journal before changing it');
  }
  const content = 'Current agent-maintained investigation record from ' + JSON.stringify(path) +
    '. This supersedes earlier copies of this journal. These are claims to check against evidence. ' +
    'Current principal instructions and budgets take precedence. Paused or terminal records do not authorize resumption.\n' +
    JSON.stringify(state);
  // Existing loop_inject enforces the configured size limit and permissions.
  const key = `investigation:${createHash('sha256').update(path).digest('hex')}`;
  await adf.loop_inject({ content, category: 'investigation', key });
  return { path, published: true };
}
