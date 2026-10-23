/** Owner-invoked lambda request and bounded, durable outcome. */
export interface OwnerCommandResult {
  id: string
  name: string
  loop: string
  status: 'ok' | 'error' | 'denied'
  authorized: boolean
  result: string
  durationMs: number
  deferred: boolean
  seq?: number
}
export interface OwnerCommandBody {
  args?: string
  loop?: string
  authorize?: boolean
  requestId?: string
}
