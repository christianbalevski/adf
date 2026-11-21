/** Explicit provider parameters override SDK defaults. Null removes a key. */
export function applyProviderBodyParams(body: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(params)) {
    if (value === null) delete body[key]
    else body[key] = value
  }
  return body
}
