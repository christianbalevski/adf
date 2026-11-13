import type { ServingConfig } from '../types/adf-v02.types'

/** Whether the agent serves anything over HTTP: a public or shared page, or API routes. */
export function servesHttp(serving: ServingConfig | undefined): boolean {
  return !!(serving?.public?.enabled || serving?.shared?.enabled || (serving?.api && serving.api.length > 0))
}
