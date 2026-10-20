/**
 * The turn interrupt: end one loop's running turn and leave its executor idle
 * and still accepting work. One implementation for every client: the daemon's
 * POST /agents/:id/interrupt (terminal app Esc, `adf interrupt`, Studio on the
 * daemon) and embedded Studio's AGENT_INTERRUPT.
 *
 * What the executor does with it (AgentExecutor.endTurnAndSetState, reason
 * 'interrupt'): the provider request is cancelled, running tools get the abort
 * signal (host shells are killed, MCP requests cancelled), the turn's pending
 * approval or question ends, every tool call without a result gets an
 * interrupted one, and the loop shows "Turn interrupted". Protections and
 * approvals raised beside the turn are not touched.
 */

import type { AgentExecutor } from './agent-executor'
import { MAIN_LOOP, type LoopPool } from './loop-pool'

export class InterruptRefusedError extends Error {
  constructor(message: string, readonly statusCode: 404 | 409) {
    super(message)
    this.name = 'InterruptRefusedError'
  }
}

export interface InterruptTurnResult {
  /** False: nothing was running (the turn had already ended). */
  interrupted: boolean
  loop: string
}

export function interruptLoopTurn(main: AgentExecutor, loopPool: Pick<LoopPool, 'hasLoop' | 'getRuntime'>, loop?: string): InterruptTurnResult {
  const loopName = loop || MAIN_LOOP
  if (!loopPool.hasLoop(loopName)) throw new InterruptRefusedError(`No loop named "${loopName}" on this agent.`, 404)
  const executor = loopName === MAIN_LOOP ? main : loopPool.getRuntime(loopName)?.executor
  if (!executor) throw new InterruptRefusedError(`Loop "${loopName}" has no running executor (it is disabled or stopping).`, 409)
  const state = executor.getState()
  if (state === 'stopped' || state === 'error') throw new InterruptRefusedError(`Cannot interrupt: loop "${loopName}" is ${state}.`, 409)
  if (!executor.isTurnActive()) return { interrupted: false, loop: loopName }
  executor.endTurnAndSetState('idle', { reason: 'interrupt' })
  return { interrupted: true, loop: loopName }
}
