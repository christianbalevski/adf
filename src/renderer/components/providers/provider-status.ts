export type ProviderTestStatus = 'ok' | 'failed' | 'unconfigured' | 'testing' | 'unknown'

export function providerDotClass(status?: ProviderTestStatus): string {
  switch (status) {
    case 'ok': return 'bg-green-500'
    case 'failed': return 'bg-red-500'
    case 'unconfigured': return 'bg-amber-400'
    case 'testing': return 'bg-neutral-400 animate-pulse'
    default: return 'bg-neutral-500/40'
  }
}

export function providerStatusLabel(status?: ProviderTestStatus): string {
  switch (status) {
    case 'ok': return 'Connected'
    case 'failed': return 'Connection failed'
    case 'unconfigured': return 'Not configured'
    case 'testing': return 'Testing…'
    default: return 'Not tested'
  }
}

export function generateProviderId(): string {
  return 'custom:' + Math.random().toString(36).slice(2, 8)
}
