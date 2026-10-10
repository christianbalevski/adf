import { describe, it, expect } from 'vitest'
import { configNavItems, configNavGroupOf } from '../../../src/renderer/components/agent/config-nav-model'

describe('configNavItems', () => {
  it('lists only present sections, in group order', () => {
    const items = configNavItems(['Security', 'Model', 'Tools', 'Identity'])
    expect(items).toEqual([
      { title: 'Identity', group: 'Base' },
      { title: 'Model', group: 'Base' },
      { title: 'Tools', group: 'Capabilities' },
      { title: 'Security', group: 'Communication' }
    ])
  })

  it('matches a query against titles and group names', () => {
    const present = ['Compute', 'Code Execution', 'Messaging', 'Channels', 'Logging']
    expect(configNavItems(present, 'COMP').map((i) => i.title)).toEqual(['Compute'])
    expect(configNavItems(present, 'communication').map((i) => i.title)).toEqual(['Channels', 'Messaging'])
  })

  it('keeps an ungrouped section reachable under Other', () => {
    expect(configNavItems(['Model', 'Brand New'])).toEqual([
      { title: 'Model', group: 'Base' },
      { title: 'Brand New', group: 'Other' }
    ])
    expect(configNavGroupOf('Brand New')).toBeNull()
  })
})
