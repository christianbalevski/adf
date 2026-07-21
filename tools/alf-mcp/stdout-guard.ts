/**
 * stdout carries the MCP protocol — any stray console.log from imported
 * modules (e.g. mdns-service) would corrupt it. Route console.log to stderr.
 * Imported first in index.ts so the patch lands before other modules run.
 */
console.log = (...args: unknown[]) => console.error(...args)

export {}
