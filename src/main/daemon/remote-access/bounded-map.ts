/**
 * A Map with a size cap that drops the least recently set key (LRU on
 * writes). For per-source counters reachable without a token (/remote/hello,
 * /pair/claim): their memory stays bounded whatever the number of sources.
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>()

  constructor(readonly cap: number) {}

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

/** Cap of the per-source counters. */
export const SOURCE_TRACKING_CAP = 1024
