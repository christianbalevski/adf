import { describe, it, expect } from 'vitest'
import { findApprovalTargetEntry } from '../../../src/renderer/hooks/approval-target'
import type { ChatHistoryEntry } from '../../../src/shared/types/adf.types'

/**
 * Which log entry a HIL approval prompt attaches to.
 *
 * LIVE BUG: the handler took `log[log.length - 1]`, assuming the matching
 * tool_call was emitted just before the request. That holds for main-loop HIL
 * only. A protection override raised by sandboxed code / a shell pipeline / an
 * async task has no log entry of its own, so a sys_set_meta override rendered
 * as "sys_code — awaiting approval — Update meta llm_tokens_total", naming a
 * call that never touched meta. And when the last entry was not a tool_call at
 * all, the prompt rendered NOWHERE while still blocking the agent.
 */

let n = 0
const call = (name: string, id = `c${++n}`): ChatHistoryEntry =>
  ({ id, type: 'tool_call', content: `Calling ${name}`, timestamp: n, metadata: { name } })
const result = (name: string): ChatHistoryEntry =>
  ({ id: `r${++n}`, type: 'tool_result', content: 'ok', timestamp: n, metadata: { name } })
const text = (): ChatHistoryEntry =>
  ({ id: `t${++n}`, type: 'text', content: 'thinking out loud', timestamp: n })

const unclaimed = () => false

describe('findApprovalTargetEntry', () => {
  it('binds main-loop HIL to the call that was just emitted', () => {
    const log = [text(), call('fs_delete', 'target')]
    expect(findApprovalTargetEntry(log, 'fs_delete', unclaimed)).toBe('target')
  })

  it('picks the matching call in a multi-tool batch, not the newest one', () => {
    const log = [call('fs_read'), call('sys_set_meta', 'target'), call('db_query')]
    expect(findApprovalTargetEntry(log, 'sys_set_meta', unclaimed)).toBe('target')
  })

  it('THE BUG: an out-of-band override does not attach to the running tool call', () => {
    // sys_code is mid-flight; a lambda it never called asks to write meta.
    const log = [text(), call('sys_code', 'sys-code-entry')]
    expect(findApprovalTargetEntry(log, 'sys_set_meta', unclaimed)).toBeNull()
  })

  it('does not attach to a call that already completed', () => {
    const log = [call('sys_set_meta', 'old'), result('sys_set_meta'), call('sys_code')]
    expect(findApprovalTargetEntry(log, 'sys_set_meta', unclaimed)).toBeNull()
  })

  it('skips a call another prompt already owns, so two approvals never collide', () => {
    const first = call('fs_write', 'first')
    const second = call('fs_write', 'second')
    const log = [first, second]
    const claimed = (id: string) => id === 'second'
    expect(findApprovalTargetEntry(log, 'fs_write', claimed)).toBe('first')
  })

  it('returns null on an empty log or when the last entry is not a tool call', () => {
    expect(findApprovalTargetEntry([], 'fs_write', unclaimed)).toBeNull()
    expect(findApprovalTargetEntry([text()], 'fs_write', unclaimed)).toBeNull()
  })
})
