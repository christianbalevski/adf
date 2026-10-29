/** A small LRU bounded by retained string bytes, including its keys. */
export class MarkdownHighlightCache {
  private entries = new Map<string, { html: string; bytes: number }>()
  private bytes = 0

  constructor(private readonly maxBytes = 4 * 1024 * 1024) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.html
  }

  set(key: string, html: string): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.bytes -= previous.bytes
      this.entries.delete(key)
    }
    // Two bytes per UTF-16 code unit is conservative for V8's one-byte strings.
    // Oversized results are returned to the caller without retaining them.
    const bytes = 2 * (key.length + html.length)
    if (bytes > this.maxBytes) return
    while (this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.bytes -= this.entries.get(oldest)!.bytes
      this.entries.delete(oldest)
    }
    this.entries.set(key, { html, bytes })
    this.bytes += bytes
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }
}
