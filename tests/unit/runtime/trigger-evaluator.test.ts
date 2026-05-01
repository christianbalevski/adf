import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TriggerEvaluator } from '../../../src/main/runtime/trigger-evaluator'
import type { AgentConfig, TimerSchedule, TriggerConfig, TriggerTarget } from '../../../src/shared/types/adf-v02.types'
import type { AdfEventDispatch, AdfBatchDispatch } from '../../../src/shared/types/adf-event.types'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'

// ===========================================================================
// Helpers
// ===========================================================================

function makeTarget(scope: 'system' | 'agent', overrides: Partial<TriggerTarget> = {}): TriggerTarget {
  return { scope, ...overrides } as TriggerTarget
}

function makeTriggerConfig(targets: TriggerTarget[], enabled = true): TriggerConfig {
  return { enabled, targets } as TriggerConfig
}

function makeConfig(triggers: Partial<Record<string, TriggerConfig>> = {}): AgentConfig {
  return {
    id: 'test-agent',
    name: 'test',
    triggers: triggers as AgentConfig['triggers'],
  } as AgentConfig
}

function collectEvents(evaluator: TriggerEvaluator): (AdfEventDispatch | AdfBatchDispatch)[] {
  const events: (AdfEventDispatch | AdfBatchDispatch)[] = []
  evaluator.on('trigger', (dispatch: AdfEventDispatch | AdfBatchDispatch) => events.push(dispatch))
  return events
}

// ===========================================================================
// State Gating
// ===========================================================================

describe('TriggerEvaluator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearAllUmbilicalBuses()
  })

  describe('state gating', () => {
    const states = ['active', 'idle', 'hibernate', 'suspended', 'off'] as const

    describe('system scope', () => {
      it('fires in all states except off', () => {
        for (const state of states) {
          const config = makeConfig({
            on_chat: makeTriggerConfig([makeTarget('system')])
          })
          const evaluator = new TriggerEvaluator(config)
          evaluator.setDisplayState(state)
          const events = collectEvents(evaluator)

          evaluator.onChat('hello')

          if (state === 'off') {
            expect(events.length).toBe(0)
          } else {
            expect(events.length).toBe(1)
            expect((events[0] as AdfEventDispatch).scope).toBe('system')
          }
        }
      })
    })

    describe('agent scope', () => {
      it('fires in active and idle states for all trigger types', () => {
        for (const state of ['active', 'idle'] as const) {
          const config = makeConfig({
            on_chat: makeTriggerConfig([makeTarget('agent')])
          })
          const evaluator = new TriggerEvaluator(config)
          evaluator.setDisplayState(state)
          const events = collectEvents(evaluator)

          evaluator.onChat('hello')

          expect(events.length).toBe(1)
          expect((events[0] as AdfEventDispatch).scope).toBe('agent')
        }
      })

      it('does not fire in suspended state', () => {
        const config = makeConfig({
          on_chat: makeTriggerConfig([makeTarget('agent')])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('suspended')
        const events = collectEvents(evaluator)

        evaluator.onChat('hello')

        expect(events.length).toBe(0)
      })

      it('does not fire in off state', () => {
        const config = makeConfig({
          on_chat: makeTriggerConfig([makeTarget('agent')])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('off')
        const events = collectEvents(evaluator)

        evaluator.onChat('hello')

        expect(events.length).toBe(0)
      })

      it('does not fire non-timer triggers in hibernate state', () => {
        const config = makeConfig({
          on_chat: makeTriggerConfig([makeTarget('agent')]),
          on_inbox: makeTriggerConfig([makeTarget('agent')])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('hibernate')
        const events = collectEvents(evaluator)

        evaluator.onChat('hello')
        evaluator.onInbox('did:key:sender', 'hi')

        expect(events.length).toBe(0)
      })
    })

    describe('both scopes simultaneously', () => {
      it('fires system target but not agent target in hibernate for on_chat', () => {
        const config = makeConfig({
          on_chat: makeTriggerConfig([
            makeTarget('system'),
            makeTarget('agent')
          ])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('hibernate')
        const events = collectEvents(evaluator)

        evaluator.onChat('hello')

        // System fires, agent does not
        expect(events.length).toBe(1)
        expect((events[0] as AdfEventDispatch).scope).toBe('system')
      })
    })
  })

  // ===========================================================================
  // Disabled triggers
  // ===========================================================================

  describe('disabled triggers', () => {
    it('does not fire when trigger is disabled', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([makeTarget('system')], false)
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('hello')

      expect(events.length).toBe(0)
    })

    it('does not fire when trigger config is missing', () => {
      const config = makeConfig({}) // no triggers configured
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('hello')

      expect(events.length).toBe(0)
    })
  })

  // ===========================================================================
  // Timing: Debounce
  // ===========================================================================

  describe('debounce', () => {
    it('fires once after quiet period', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([
          makeTarget('system', { debounce_ms: 500 })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('msg1')
      expect(events.length).toBe(0)

      vi.advanceTimersByTime(500)
      expect(events.length).toBe(1)
    })

    it('resets timer on new event', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([
          makeTarget('system', { debounce_ms: 500 })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('msg1')
      vi.advanceTimersByTime(300)
      expect(events.length).toBe(0)

      evaluator.onChat('msg2') // resets the timer
      vi.advanceTimersByTime(300)
      expect(events.length).toBe(0) // still waiting

      vi.advanceTimersByTime(200)
      expect(events.length).toBe(1) // fires 500ms after msg2
    })

    it('only fires once for rapid events', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([
          makeTarget('system', { debounce_ms: 100 })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      for (let i = 0; i < 10; i++) {
        evaluator.onChat(`msg${i}`)
        vi.advanceTimersByTime(50) // within debounce window
      }
      vi.advanceTimersByTime(100)
      expect(events.length).toBe(1)
    })
  })

  // ===========================================================================
  // Timing: Interval
  // ===========================================================================

  describe('interval', () => {
    it('fires on first event, drops subsequent events within interval', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { interval_ms: 1000, filter: { watch: '*' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onFileChange('test.txt', 'update')
      expect(events.length).toBe(1) // fires immediately

      evaluator.onFileChange('test.txt', 'update')
      evaluator.onFileChange('test.txt', 'update')
      expect(events.length).toBe(1) // dropped — interval not elapsed

      vi.advanceTimersByTime(1000)
      evaluator.onFileChange('test.txt', 'update')
      expect(events.length).toBe(2) // fires — interval elapsed
    })
  })

  // ===========================================================================
  // Timing: Batch
  // ===========================================================================

  describe('batch', () => {
    it('collects events during window and fires once', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { batch_ms: 500, filter: { watch: '*' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onFileChange('a.txt', 'create')
      evaluator.onFileChange('b.txt', 'update')
      evaluator.onFileChange('c.txt', 'delete')
      expect(events.length).toBe(0)

      vi.advanceTimersByTime(500)
      expect(events.length).toBe(1)
      expect('events' in events[0]).toBe(true)
      expect((events[0] as AdfBatchDispatch).events.length).toBe(3)
    })

    it('emits trigger.fired when a batch dispatch fires', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { batch_ms: 500, filter: { watch: '*' } })
        ])
      })
      const fired: string[] = []
      ensureUmbilicalBus('test-agent').subscribe(event => {
        if (event.event_type === 'trigger.fired') {
          fired.push(event.payload.trigger_type as string)
        }
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')

      evaluator.onFileChange('a.txt', 'create')
      evaluator.onFileChange('b.txt', 'update')
      vi.advanceTimersByTime(500)

      expect(fired).toEqual(['on_file_change'])
    })

    it('fires early when batch_count threshold reached', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { batch_ms: 5000, batch_count: 2, filter: { watch: '*' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onFileChange('a.txt', 'create')
      expect(events.length).toBe(0) // below threshold

      evaluator.onFileChange('b.txt', 'update')
      expect(events.length).toBe(1) // threshold reached, fires early
      expect((events[0] as AdfBatchDispatch).events.length).toBe(2)
    })

    it('emits single item without batchedItems wrapper', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { batch_ms: 100, filter: { watch: '*' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onFileChange('a.txt', 'create')
      vi.advanceTimersByTime(100)

      expect(events.length).toBe(1)
      // Single item — should be AdfEventDispatch, not AdfBatchDispatch
      expect('event' in events[0]).toBe(true)
      expect(((events[0] as AdfEventDispatch).event.data as any).path).toBe('a.txt')
    })
  })

  // ===========================================================================
  // Filter Matching
  // ===========================================================================

  describe('filter matching', () => {
    describe('on_inbox filters', () => {
      it('filters by source', () => {
        const config = makeConfig({
          on_inbox: makeTriggerConfig([
            makeTarget('system', { filter: { source: 'telegram' } })
          ])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('active')
        const events = collectEvents(evaluator)

        evaluator.onInbox('sender1', 'hello', { source: 'mesh' })
        expect(events.length).toBe(0) // source doesn't match

        evaluator.onInbox('sender2', 'hello', { source: 'telegram' })
        expect(events.length).toBe(1) // source matches
      })

      it('filters by sender', () => {
        const config = makeConfig({
          on_inbox: makeTriggerConfig([
            makeTarget('system', { filter: { sender: 'did:key:alice' } })
          ])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('active')
        const events = collectEvents(evaluator)

        evaluator.onInbox('did:key:bob', 'hello')
        expect(events.length).toBe(0)

        evaluator.onInbox('did:key:alice', 'hello')
        expect(events.length).toBe(1)
      })
    })

    describe('on_file_change filters', () => {
      it('matches glob watch pattern', () => {
        const config = makeConfig({
          on_file_change: makeTriggerConfig([
            makeTarget('system', { filter: { watch: 'document.*' } })
          ])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('active')
        const events = collectEvents(evaluator)

        evaluator.onFileChange('document.md', 'update')
        expect(events.length).toBe(1)

        evaluator.onFileChange('document.txt', 'update')
        expect(events.length).toBe(2)

        evaluator.onFileChange('other.md', 'update')
        expect(events.length).toBe(2) // doesn't match
      })

      it('matches wildcard patterns', () => {
        const config = makeConfig({
          on_file_change: makeTriggerConfig([
            makeTarget('system', { filter: { watch: 'public/data/*.json' } })
          ])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('active')
        const events = collectEvents(evaluator)

        evaluator.onFileChange('public/data/report.json', 'update')
        expect(events.length).toBe(1)

        evaluator.onFileChange('public/data/report.csv', 'update')
        expect(events.length).toBe(1) // csv doesn't match *.json

        evaluator.onFileChange('private/data/report.json', 'update')
        expect(events.length).toBe(1) // wrong prefix
      })
    })

    describe('on_tool_call filters', () => {
      it('matches exact tool names', () => {
        const config = makeConfig({
          on_tool_call: makeTriggerConfig([
            makeTarget('system', { filter: { tools: ['sys_create_agent'] } })
          ])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('active')
        const events = collectEvents(evaluator)

        evaluator.onToolCall('sys_create_agent', '{}', 'task1')
        expect(events.length).toBe(1)

        evaluator.onToolCall('fs_write', '{}', 'task2')
        expect(events.length).toBe(1) // doesn't match
      })

      it('matches wildcard tool patterns', () => {
        const config = makeConfig({
          on_tool_call: makeTriggerConfig([
            makeTarget('system', { filter: { tools: ['mcp:*'] } })
          ])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('active')
        const events = collectEvents(evaluator)

        evaluator.onToolCall('mcp:telegram:send', '{}', 'task1')
        expect(events.length).toBe(1)

        evaluator.onToolCall('mcp:github:create_issue', '{}', 'task2')
        expect(events.length).toBe(2)

        evaluator.onToolCall('fs_write', '{}', 'task3')
        expect(events.length).toBe(2) // doesn't match mcp:*
      })
    })

    describe('no filter (passthrough)', () => {
      it('fires for all events when no filter is set', () => {
        const config = makeConfig({
          on_chat: makeTriggerConfig([makeTarget('system')])
        })
        const evaluator = new TriggerEvaluator(config)
        evaluator.setDisplayState('active')
        const events = collectEvents(evaluator)

        evaluator.onChat('anything')
        expect(events.length).toBe(1)
      })
    })
  })

  // ===========================================================================
  // Multiple targets
  // ===========================================================================

  describe('multiple targets', () => {
    it('evaluates each target independently', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([
          makeTarget('system'),
          makeTarget('agent'),
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('hello')

      expect(events.length).toBe(2)
      const scopes = events.map(e => e.scope).sort()
      expect(scopes).toEqual(['agent', 'system'])
    })

    it('different targets can have different timing', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([
          makeTarget('system'), // immediate
          makeTarget('agent', { debounce_ms: 500 }), // debounced
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('hello')

      expect(events.length).toBe(1) // only immediate target fires
      expect((events[0] as AdfEventDispatch).scope).toBe('system')

      vi.advanceTimersByTime(500)
      expect(events.length).toBe(2) // debounced target fires
      expect(events[1].scope).toBe('agent')
    })
  })

  // ===========================================================================
  // Event data passthrough
  // ===========================================================================

  describe('event data', () => {
    it('on_chat passes userMessage', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('hello world')

      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('chat')
      const textBlock = (d.event.data as any).message.content_json?.find((b: any) => b.type === 'text')
      expect(textBlock?.text).toBe('hello world')
    })

    it('on_inbox passes sender and message data', () => {
      const config = makeConfig({
        on_inbox: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onInbox('did:key:alice', 'hello', { source: 'mesh', messageId: 'msg1' })

      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('inbox')
      expect((d.event.data as any).message.from).toBe('did:key:alice')
      expect((d.event.data as any).message.content).toBe('hello')
      expect((d.event.data as any).message.id).toBe('msg1')
    })

    it('on_file_change passes path and operation', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { filter: { watch: '*' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onFileChange('data/report.json', 'update', 'new content')

      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('file_change')
      expect((d.event.data as any).path).toBe('data/report.json')
      expect((d.event.data as any).operation).toBe('update')
    })
  })

  // ===========================================================================
  // Filter matching — additional trigger types
  // ===========================================================================

  describe('filter matching — outbox, task_complete, logs', () => {
    it('on_outbox: filters by recipient', () => {
      const config = makeConfig({
        on_outbox: makeTriggerConfig([
          makeTarget('system', { filter: { to: 'did:key:bob' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onOutbox('did:key:bob', 'hello')
      expect(events.length).toBe(1)

      evaluator.onOutbox('did:key:charlie', 'hello')
      expect(events.length).toBe(1) // filtered out
    })

    it('on_task_complete: filters by tool and status', () => {
      const config = makeConfig({
        on_task_complete: makeTriggerConfig([
          makeTarget('system', { filter: { tools: ['sys_code'], status: 'error' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onTaskComplete('t1', 'sys_code', 'error', undefined, 'boom')
      expect(events.length).toBe(1)

      evaluator.onTaskComplete('t2', 'sys_code', 'success', 'ok')
      expect(events.length).toBe(1) // wrong status

      evaluator.onTaskComplete('t3', 'fs_read', 'error', undefined, 'oops')
      expect(events.length).toBe(1) // wrong tool
    })

    it('on_task_complete: glob matches tool pattern', () => {
      const config = makeConfig({
        on_task_complete: makeTriggerConfig([
          makeTarget('system', { filter: { tools: ['mcp:*'] } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onTaskComplete('t1', 'mcp:github:run', 'success', 'done')
      expect(events.length).toBe(1)

      evaluator.onTaskComplete('t2', 'sys_code', 'success', 'done')
      expect(events.length).toBe(1) // doesn't match
    })

    it('on_logs: filters by level', () => {
      const config = makeConfig({
        on_logs: makeTriggerConfig([
          makeTarget('system', { filter: { level: ['error', 'warn'] } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onLog('error', null, null, null, 'crash')
      expect(events.length).toBe(1)

      evaluator.onLog('warn', null, null, null, 'watch out')
      expect(events.length).toBe(2)

      evaluator.onLog('info', null, null, null, 'fine')
      expect(events.length).toBe(2) // level not in filter
    })

    it('on_logs: filters by origin with glob', () => {
      const config = makeConfig({
        on_logs: makeTriggerConfig([
          makeTarget('system', { filter: { origin: ['sys_lambda:*'] } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onLog('info', 'sys_lambda:lib/handler.ts', null, null, 'ran')
      expect(events.length).toBe(1)

      evaluator.onLog('info', 'agent', null, null, 'thinking')
      expect(events.length).toBe(1) // doesn't match
    })

    it('on_logs: filters by event with glob', () => {
      const config = makeConfig({
        on_logs: makeTriggerConfig([
          makeTarget('system', { filter: { event: ['on_timer'] } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onLog('info', null, 'on_timer', null, 'timer fired')
      expect(events.length).toBe(1)

      evaluator.onLog('info', null, 'on_inbox', null, 'message arrived')
      expect(events.length).toBe(1) // doesn't match
    })
  })

  // ===========================================================================
  // Event data — additional trigger types
  // ===========================================================================

  describe('event data — outbox, tool_call, task_complete', () => {
    it('on_outbox passes recipient and message', () => {
      const config = makeConfig({
        on_outbox: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onOutbox('did:key:bob', 'hello bob')

      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('outbox')
      expect((d.event.data as any).message.to).toBe('did:key:bob')
      expect((d.event.data as any).message.content).toBe('hello bob')
    })

    it('on_tool_call passes tool name, args, taskId, origin', () => {
      const config = makeConfig({
        on_tool_call: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onToolCall('fs_read', '{"path":"x.txt"}', 'task-42', 'agent')

      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('tool_call')
      expect((d.event.data as any).toolName).toBe('fs_read')
      expect((d.event.data as any).args).toEqual({ path: 'x.txt' })
      expect((d.event.data as any).origin).toBe('agent')
    })

    it('on_task_complete passes status, result, error', () => {
      const config = makeConfig({
        on_task_complete: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onTaskComplete('t1', 'sys_code', 'error', undefined, 'stack overflow')

      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('task_complete')
      expect((d.event.data as any).task.id).toBe('t1')
      expect((d.event.data as any).task.tool).toBe('sys_code')
      expect((d.event.data as any).task.status).toBe('error')
      expect((d.event.data as any).task.error).toBe('stack overflow')
    })

    it('on_file_change computes diff from previous content', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { filter: { watch: '*' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onFileChange('doc.md', 'modified', 'line1\nline2', 'line1\nold')

      const d = events[0] as AdfEventDispatch
      expect((d.event.data as any).diff).toContain('-old')
      expect((d.event.data as any).diff).toContain('+line2')
    })

    it('target lambda/command/warm are passed through', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([
          makeTarget('system', {
            lambda: 'lib/handler.ts:onChat',
            command: 'echo hi',
            warm: true,
          })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('hey')

      const d = events[0] as AdfEventDispatch
      expect(d.lambda).toBe('lib/handler.ts:onChat')
      expect(d.command).toBe('echo hi')
      expect(d.warm).toBe(true)
    })
  })

  // ===========================================================================
  // Timer polling (checkTimers)
  // ===========================================================================

  describe('timer polling (checkTimers)', () => {
    function makeWorkspaceMock(expired: Array<{
      id: number
      schedule: TimerSchedule
      payload: string
      scope: ('system' | 'agent')[]
      lambda?: string | null
      warm?: boolean
      run_count: number
      created_at: number
    }>) {
      return {
        getExpiredTimers: vi.fn(() => expired),
        deleteTimers: vi.fn(),
        renewTimer: vi.fn(),
        insertLog: vi.fn(),
        getInbox: vi.fn(() => []),
        getUnreadCount: vi.fn(() => 0),
      } as any
    }

    it('fires expired timer with agent scope', () => {
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('agent')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([{
        id: 1,
        schedule: { mode: 'once' as const, at: Date.now() - 1000 },
        payload: 'do stuff',
        scope: ['agent'],
        lambda: null,
        warm: false,
        run_count: 0,
        created_at: Date.now() - 5000,
      }])

      evaluator.startTimerPolling(ws)
      vi.advanceTimersByTime(5000)

      expect(ws.getExpiredTimers).toHaveBeenCalled()
      expect(ws.deleteTimers).toHaveBeenCalledWith([1])
      expect(events.length).toBe(1)
      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('timer')
      expect(d.scope).toBe('agent')
      expect((d.event.data as any).timer.payload).toBe('do stuff')

      evaluator.dispose()
    })

    it('fires system timer with lambda', () => {
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([{
        id: 2,
        schedule: { mode: 'once' as const, at: Date.now() - 500 },
        payload: 'timer payload',
        scope: ['system'],
        lambda: 'lib/handler.ts:onTimer',
        warm: true,
        run_count: 0,
        created_at: Date.now() - 3000,
      }])

      evaluator.startTimerPolling(ws)
      vi.advanceTimersByTime(5000)

      expect(events.length).toBe(1)
      const d = events[0] as AdfEventDispatch
      expect(d.event.type).toBe('timer')
      expect(d.scope).toBe('system')
      expect(d.lambda).toBe('lib/handler.ts:onTimer')
      expect(d.warm).toBe(true)

      evaluator.dispose()
    })

    it('skips system timer without lambda (logs skip)', () => {
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([{
        id: 3,
        schedule: { mode: 'once' as const, at: Date.now() - 100 },
        payload: 'no-lambda',
        scope: ['system'],
        lambda: null,
        warm: false,
        run_count: 0,
        created_at: Date.now() - 2000,
      }])

      evaluator.startTimerPolling(ws)
      vi.advanceTimersByTime(5000)

      expect(events.length).toBe(0)
      expect(ws.insertLog).toHaveBeenCalled()

      evaluator.dispose()
    })

    it('does not fire when on_timer is disabled', () => {
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('agent')], false)
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([{
        id: 4,
        schedule: { mode: 'once' as const, at: Date.now() - 100 },
        payload: 'nope',
        scope: ['agent'],
        lambda: null,
        warm: false,
        run_count: 0,
        created_at: Date.now() - 1000,
      }])

      evaluator.startTimerPolling(ws)
      vi.advanceTimersByTime(5000)

      // Timer is still deleted even when disabled
      expect(ws.deleteTimers).toHaveBeenCalledWith([4])
      expect(events.length).toBe(0)

      evaluator.dispose()
    })

    it('respects state gating — agent scope blocked in suspended', () => {
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('agent')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('suspended')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([{
        id: 5,
        schedule: { mode: 'once' as const, at: Date.now() - 100 },
        payload: 'blocked',
        scope: ['agent'],
        lambda: null,
        warm: false,
        run_count: 0,
        created_at: Date.now() - 1000,
      }])

      evaluator.startTimerPolling(ws)
      vi.advanceTimersByTime(5000)

      expect(events.length).toBe(0)

      evaluator.dispose()
    })

    it('no expired timers — no events emitted', () => {
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('agent')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([]) // nothing expired

      evaluator.startTimerPolling(ws)
      vi.advanceTimersByTime(5000)

      expect(events.length).toBe(0)
      expect(ws.deleteTimers).not.toHaveBeenCalled()

      evaluator.dispose()
    })

    it('does not throw from the polling interval when deleting expired timers fails', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('agent')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([{
        id: 6,
        schedule: { mode: 'once' as const, at: Date.now() - 100 },
        payload: 'disk trouble',
        scope: ['agent'],
        lambda: null,
        warm: false,
        run_count: 0,
        created_at: Date.now() - 1000,
      }])
      ws.deleteTimers.mockImplementation(() => {
        throw new Error('disk I/O error')
      })

      evaluator.startTimerPolling(ws)
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
      expect(ws.deleteTimers).toHaveBeenCalledWith([6])
      expect(ws.insertLog).toHaveBeenCalledWith(
        'error', 'timer', 'delete_expired_failed', null,
        'Failed to delete expired timers: disk I/O error',
        { timer_ids: [6] }
      )
      expect(events.length).toBe(0)

      evaluator.dispose()
      consoleSpy.mockRestore()
    })

    it('does not throw from the polling interval when renewing a recurring timer fails', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const config = makeConfig({
        on_timer: makeTriggerConfig([makeTarget('agent')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      const ws = makeWorkspaceMock([{
        id: 7,
        schedule: { mode: 'interval' as const, every_ms: 1000 },
        payload: 'tick',
        scope: ['agent'],
        lambda: null,
        warm: false,
        run_count: 0,
        created_at: Date.now() - 1000,
      }])
      ws.renewTimer.mockImplementation(() => {
        throw new Error('disk I/O error')
      })

      evaluator.startTimerPolling(ws)
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
      expect(ws.deleteTimers).toHaveBeenCalledWith([7])
      expect(ws.renewTimer).toHaveBeenCalled()
      expect(ws.insertLog).toHaveBeenCalledWith(
        'error', 'timer', 'renew_failed', null,
        'Failed to renew timer #7: disk I/O error',
        { timer_id: 7 }
      )
      expect(events.length).toBe(1)

      evaluator.dispose()
      consoleSpy.mockRestore()
    })
  })

  // ===========================================================================
  // Inbox interval
  // ===========================================================================

  describe('inbox interval', () => {
    it('delays fire until end of window, absorbs subsequent events', () => {
      const config = makeConfig({
        on_inbox: makeTriggerConfig([
          makeTarget('system', { interval_ms: 300 })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onInbox('alice', 'msg1', { source: 'mesh' })
      expect(events.length).toBe(0) // not immediate for inbox interval

      evaluator.onInbox('alice', 'msg2', { source: 'mesh' })
      expect(events.length).toBe(0) // absorbed

      vi.advanceTimersByTime(300)
      expect(events.length).toBe(1)

      evaluator.dispose()
    })
  })

  // ===========================================================================
  // Cleanup / Dispose
  // ===========================================================================

  describe('cleanup', () => {
    it('stopTimerPolling clears interval', () => {
      const config = makeConfig({})
      const evaluator = new TriggerEvaluator(config)

      const mockWorkspace = {
        getExpiredTimers: vi.fn(() => []),
        getInbox: vi.fn(() => []),
        getUnreadCount: vi.fn(() => 0),
      } as any

      evaluator.startTimerPolling(mockWorkspace)
      evaluator.stopTimerPolling()

      // Advance time — no errors should occur (interval was cleared)
      vi.advanceTimersByTime(60000)
    })

    it('dispose clears pending debounce timers', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([
          makeTarget('system', { debounce_ms: 1000 })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('pending')
      evaluator.dispose()

      vi.advanceTimersByTime(1000)
      expect(events.length).toBe(0) // timer was cleared
    })

    it('dispose clears pending batch timers', () => {
      const config = makeConfig({
        on_file_change: makeTriggerConfig([
          makeTarget('system', { batch_ms: 500, filter: { watch: '*' } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onFileChange('a.txt', 'modified')
      evaluator.dispose()

      vi.advanceTimersByTime(500)
      expect(events.length).toBe(0) // batch timer was cleared
    })

    it('dispose clears pending inbox interval timers', () => {
      const config = makeConfig({
        on_inbox: makeTriggerConfig([
          makeTarget('system', { interval_ms: 1000 })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onInbox('alice', 'msg', { source: 'mesh' })
      evaluator.dispose()

      vi.advanceTimersByTime(1000)
      expect(events.length).toBe(0) // inbox interval was cleared
    })
  })

  // ===========================================================================
  // updateConfig
  // ===========================================================================

  describe('updateConfig', () => {
    it('new config takes effect immediately', () => {
      const config = makeConfig({
        on_chat: makeTriggerConfig([makeTarget('agent')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onChat('works')
      expect(events.length).toBe(1)

      // Disable trigger
      evaluator.updateConfig(makeConfig({
        on_chat: makeTriggerConfig([makeTarget('agent')], false)
      }))

      evaluator.onChat('blocked')
      expect(events.length).toBe(1) // still 1

      evaluator.dispose()
    })
  })

  // ===========================================================================
  // DB lookup paths — full row vs fallback
  // ===========================================================================

  describe('DB lookup — onInbox full InboxMessage', () => {
    it('uses full InboxMessage from workspace when messageId is provided', () => {
      const config = makeConfig({
        on_inbox: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')

      const fullRow = {
        id: 'inbox-123',
        from: 'telegram:765273985',
        to: 'agent:mybot',
        network: 'devnet',
        thread_id: 'thread-1',
        parent_id: 'parent-1',
        subject: 'Re: hello',
        content: 'Yes',
        content_type: 'text/plain',
        sender_alias: 'Christian',
        recipient_alias: 'MyBot',
        message_id: 'alf-msg-1',
        owner: 'did:key:owner1',
        card: 'https://example.com/card',
        return_path: 'telegram:765273985',
        source: 'telegram',
        source_context: { chat_id: '765273985', message_id: '1032' },
        sent_at: 1700000000000,
        received_at: 1700000001000,
        status: 'unread' as const,
      }

      const mockWorkspace = { getInboxMessageById: vi.fn().mockReturnValue(fullRow) }
      evaluator.setWorkspace(mockWorkspace as any)

      const events = collectEvents(evaluator)
      evaluator.onInbox('telegram:765273985', 'Yes', { source: 'telegram', messageId: 'inbox-123' })

      expect(mockWorkspace.getInboxMessageById).toHaveBeenCalledWith('inbox-123')
      const msg = (events[0] as AdfEventDispatch).event.data as any
      expect(msg.message).toBe(fullRow)
      expect(msg.message.network).toBe('devnet')
      expect(msg.message.sender_alias).toBe('Christian')
      expect(msg.message.source_context).toEqual({ chat_id: '765273985', message_id: '1032' })
      expect(msg.message.sent_at).toBe(1700000000000)
      expect(msg.message.parent_id).toBe('parent-1')
    })

    it('falls back to minimal object when workspace is not set', () => {
      const config = makeConfig({
        on_inbox: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      // No setWorkspace call

      const events = collectEvents(evaluator)
      evaluator.onInbox('telegram:123', 'hi', {
        source: 'telegram',
        messageId: 'msg-1',
        parentId: 'parent-1',
        threadId: 'thread-1',
        sourceMeta: { chat_id: '123' }
      })

      const msg = (events[0] as AdfEventDispatch).event.data as any
      // Fallback should still include all opts fields
      expect(msg.message.id).toBe('msg-1')
      expect(msg.message.from).toBe('telegram:123')
      expect(msg.message.content).toBe('hi')
      expect(msg.message.parent_id).toBe('parent-1')
      expect(msg.message.thread_id).toBe('thread-1')
      expect(msg.message.source_context).toEqual({ chat_id: '123' })
      expect(msg.message.source).toBe('telegram')
      // Fields only available via DB should be absent
      expect(msg.message.network).toBeUndefined()
      expect(msg.message.sender_alias).toBeUndefined()
      expect(msg.message.sent_at).toBeUndefined()
    })

    it('falls back to minimal object when getInboxMessageById returns null', () => {
      const config = makeConfig({
        on_inbox: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')

      const mockWorkspace = { getInboxMessageById: vi.fn().mockReturnValue(null) }
      evaluator.setWorkspace(mockWorkspace as any)

      const events = collectEvents(evaluator)
      evaluator.onInbox('mesh:alice', 'hello', { source: 'mesh', messageId: 'missing-id' })

      expect(mockWorkspace.getInboxMessageById).toHaveBeenCalledWith('missing-id')
      const msg = (events[0] as AdfEventDispatch).event.data as any
      expect(msg.message.id).toBe('missing-id')
      expect(msg.message.from).toBe('mesh:alice')
      expect(msg.message.network).toBeUndefined()
    })
  })

  // ===========================================================================
  // DB lookup — onTaskComplete full TaskEntry
  // ===========================================================================

  describe('DB lookup — onTaskComplete full TaskEntry', () => {
    it('uses full TaskEntry from workspace when available', () => {
      const config = makeConfig({
        on_task_complete: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')

      const fullTask = {
        id: 'task-42',
        tool: 'sys_code',
        args: '{"code":"console.log(1)"}',
        status: 'success' as const,
        result: '1\n',
        created_at: 1700000000000,
        completed_at: 1700000001000,
        origin: 'agent',
      }

      const mockWorkspace = { getTask: vi.fn().mockReturnValue(fullTask) }
      evaluator.setWorkspace(mockWorkspace as any)

      const events = collectEvents(evaluator)
      evaluator.onTaskComplete('task-42', 'sys_code', 'success', '1\n')

      expect(mockWorkspace.getTask).toHaveBeenCalledWith('task-42')
      const task = (events[0] as AdfEventDispatch).event.data as any
      expect(task.task).toBe(fullTask)
      expect(task.task.args).toBe('{"code":"console.log(1)"}')
      expect(task.task.completed_at).toBe(1700000001000)
      expect(task.task.origin).toBe('agent')
    })

    it('falls back to minimal task when workspace has no row', () => {
      const config = makeConfig({
        on_task_complete: makeTriggerConfig([makeTarget('system')])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')

      const mockWorkspace = { getTask: vi.fn().mockReturnValue(null) }
      evaluator.setWorkspace(mockWorkspace as any)

      const events = collectEvents(evaluator)
      evaluator.onTaskComplete('task-99', 'fs_read', 'error', undefined, 'ENOENT')

      const task = (events[0] as AdfEventDispatch).event.data as any
      expect(task.task.id).toBe('task-99')
      expect(task.task.tool).toBe('fs_read')
      expect(task.task.status).toBe('error')
      expect(task.task.error).toBe('ENOENT')
      // Fallback doesn't have completed_at or origin
      expect(task.task.completed_at).toBeUndefined()
      expect(task.task.origin).toBeUndefined()
    })
  })

  describe('on_llm_call filters', () => {
    it('matches source and provider filters', () => {
      const config = makeConfig({
        on_llm_call: makeTriggerConfig([
          makeTarget('system', { filter: { source: ['turn'], provider: ['openrouter'] } })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onLlmCall({
        provider: 'openrouter',
        model: 'gpt-5.4',
        source: 'turn',
        input_tokens: 100,
        output_tokens: 20,
        duration_ms: 500,
        stop_reason: 'end_turn',
      })
      expect(events.length).toBe(1)

      evaluator.onLlmCall({
        provider: 'openrouter',
        model: 'gpt-5.4',
        source: 'compaction',
        input_tokens: 100,
        output_tokens: 20,
        duration_ms: 500,
        stop_reason: 'end_turn',
      })
      expect(events.length).toBe(1)

      evaluator.onLlmCall({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        source: 'turn',
        input_tokens: 100,
        output_tokens: 20,
        duration_ms: 500,
        stop_reason: 'end_turn',
      })
      expect(events.length).toBe(1)
    })

    it('batches llm_call events', () => {
      const config = makeConfig({
        on_llm_call: makeTriggerConfig([
          makeTarget('system', { batch_ms: 1000 })
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onLlmCall({
        provider: 'openrouter',
        model: 'gpt-5.4',
        source: 'turn',
        input_tokens: 100,
        output_tokens: 20,
        duration_ms: 500,
        stop_reason: 'end_turn',
      })
      evaluator.onLlmCall({
        provider: 'openrouter',
        model: 'gpt-5.4',
        source: 'turn',
        input_tokens: 200,
        output_tokens: 40,
        duration_ms: 700,
        stop_reason: 'tool_use',
      })

      expect(events.length).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(events.length).toBe(1)
      expect((events[0] as AdfBatchDispatch).count).toBe(2)
    })
  })

  // ===========================================================================
  // skipSystemScope propagation — onToolCall
  // ===========================================================================

  describe('skipSystemScope — onToolCall', () => {
    it('skips system-scope targets when skipSystemScope is true', () => {
      const config = makeConfig({
        on_tool_call: makeTriggerConfig([
          makeTarget('system'),
          makeTarget('agent')
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onToolCall('fs_read', '{}', 'task-1', 'agent', true)

      // Only agent-scope target should fire
      expect(events.length).toBe(1)
      expect((events[0] as AdfEventDispatch).scope).toBe('agent')
    })

    it('fires both scopes when skipSystemScope is false', () => {
      const config = makeConfig({
        on_tool_call: makeTriggerConfig([
          makeTarget('system'),
          makeTarget('agent')
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onToolCall('fs_read', '{}', 'task-1', 'agent', false)

      expect(events.length).toBe(2)
      expect((events[0] as AdfEventDispatch).scope).toBe('system')
      expect((events[1] as AdfEventDispatch).scope).toBe('agent')
    })

    it('fires both scopes when skipSystemScope is undefined', () => {
      const config = makeConfig({
        on_tool_call: makeTriggerConfig([
          makeTarget('system'),
          makeTarget('agent')
        ])
      })
      const evaluator = new TriggerEvaluator(config)
      evaluator.setDisplayState('active')
      const events = collectEvents(evaluator)

      evaluator.onToolCall('fs_read', '{}', 'task-1', 'agent')

      expect(events.length).toBe(2)
    })
  })
})
