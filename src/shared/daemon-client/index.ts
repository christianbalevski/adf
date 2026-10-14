// The daemon HTTP client shared by the terminal app and Studio main (design D8).
// Portable: no Node or DOM imports. Credentials are injected; the Node
// implementation is src/main/cli/daemon-url.ts (daemonCredentials).

export * from './client'
export * from './sse'
export * from './normalize'
export * from './types'
