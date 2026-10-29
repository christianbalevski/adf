/** Browser storage may be unavailable (private mode/policy) or contain old data. */
export function readStored<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw) as T
  } catch { return fallback }
}

export function browserId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // getRandomValues is available on HTTP LAN origins as well as secure contexts.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Retain a session on reload, but split duplicated tabs that copied sessionStorage. */
export async function claimBrowserClient(key: string): Promise<string> {
  let id: string
  try { id = sessionStorage.getItem(key) || browserId() } catch { id = browserId() }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id)) id = browserId()
  if (typeof BroadcastChannel !== 'undefined') {
    const instance = browserId()
    const channel = new BroadcastChannel('adf.web.client-claims')
    let taken = false
    channel.onmessage = ({ data }) => {
      if (data?.type === 'probe' && data.id === id && data.instance !== instance) channel.postMessage({ type: 'taken', instance: data.instance })
      if (data?.type === 'taken' && data.instance === instance) taken = true
    }
    channel.postMessage({ type: 'probe', id, instance })
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (taken) id = browserId()
    // Keep answering probes while this page owns the client.
    window.addEventListener('pagehide', () => channel.close(), { once: true })
  } else {
    // Without cross-tab coordination, isolation is more important than reload reuse.
    id = browserId()
  }
  try { sessionStorage.setItem(key, id) } catch { /* still works for this page */ }
  return id
}
