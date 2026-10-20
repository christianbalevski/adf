/**
 * The navigation shell: Home navigates and never closes the open agent; the
 * open agent's nav item goes back to it. Failed starts and stops are shown
 * (failure notices). Sidebar row markers: an agent in its own window, an
 * unreviewed agent. State and helpers only: the harness has no DOM.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { location: { search: '' }, adfApi: { platform: 'linux' }, addEventListener: () => {}, removeEventListener: () => {} })

const { useAppStore } = await import('../../../src/renderer/stores/app.store')
const { useFailureNoticesStore, failureReason, agentNameOf, reportFailure, MAX_FAILURE_NOTICES } = await import('../../../src/renderer/stores/failure-notices.store')
const { isInAgentWindow } = await import('../../../src/renderer/stores/open-agent-windows.store')
const { useTrackedDirsStore } = await import('../../../src/renderer/stores/tracked-dirs.store')
const { shortcutLabel } = await import('../../../src/renderer/utils/shortcut-label')

const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const FILE_1 = '/agents/agent-1.adf'
const FILE_2 = '/agents/team/agent-2.adf'

beforeEach(() => {
  useAppStore.setState({ showSettings: false, showMeshGraph: false, showHome: false })
  useFailureNoticesStore.setState({ notices: [] })
})

describe('Home with an agent open', () => {
  it('Home shows Home and leaves Settings and the map; nothing about the agent changes', () => {
    useAppStore.setState({ showSettings: true })
    useAppStore.getState().setShowHome(true)
    expect(useAppStore.getState()).toMatchObject({ showHome: true, showSettings: false, showMeshGraph: false })
    useAppStore.setState({ showMeshGraph: true, showHome: false })
    useAppStore.getState().setShowHome(true)
    expect(useAppStore.getState()).toMatchObject({ showHome: true, showMeshGraph: false })
  })

  it('Settings, the map and the agent nav item leave Home', () => {
    useAppStore.getState().setShowHome(true)
    useAppStore.getState().setShowSettings(true)
    expect(useAppStore.getState()).toMatchObject({ showHome: false, showSettings: true })

    useAppStore.getState().setShowHome(true)
    useAppStore.getState().setShowMeshGraph(true)
    expect(useAppStore.getState()).toMatchObject({ showHome: false, showMeshGraph: true })

    useAppStore.getState().setShowHome(true)
    useAppStore.getState().openSettingsAt('providers')
    expect(useAppStore.getState()).toMatchObject({ showHome: false, showSettings: true })

    useAppStore.getState().setShowHome(true)
    useAppStore.getState().setShowHome(false)
    expect(useAppStore.getState().showHome).toBe(false)
  })

  it('closing Settings or the map does not turn Home on', () => {
    useAppStore.getState().setShowSettings(true)
    useAppStore.getState().setShowSettings(false)
    useAppStore.getState().setShowMeshGraph(true)
    useAppStore.getState().setShowMeshGraph(false)
    expect(useAppStore.getState().showHome).toBe(false)
  })
})

describe('failure notices', () => {
  it('the reason without Electron\'s wrapper', () => {
    expect(failureReason(new Error("Error invoking remote method 'adf:agent:stop': Error: the ADF daemon did not answer"))).toBe('the ADF daemon did not answer')
    expect(failureReason('provider missing')).toBe('provider missing')
    expect(failureReason(undefined)).toBe('')
  })

  it('the agent name from its file, either separator', () => {
    expect(agentNameOf(FILE_1)).toBe('agent-1')
    expect(agentNameOf('C:\\agents\\agent-2.ADF')).toBe('agent-2')
  })

  it('reportFailure shows what failed and why; the same failure twice is one notice; at most three', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportFailure('agent-1 did not stop', new Error('timed out'))
    reportFailure('agent-1 did not stop', new Error('timed out'))
    expect(useFailureNoticesStore.getState().notices.map((n) => n.text)).toEqual(['agent-1 did not stop: timed out'])
    reportFailure('agent-2 did not start')
    reportFailure('Folder not tracked', 'permission denied')
    reportFailure('agent-3 did not start', { toString: () => 'no provider' })
    const texts = useFailureNoticesStore.getState().notices.map((n) => n.text)
    expect(texts).toHaveLength(MAX_FAILURE_NOTICES)
    expect(texts).toEqual(['agent-2 did not start', 'Folder not tracked: permission denied', 'agent-3 did not start: no provider'])
    // Logged too.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a notice stays until dismissed', () => {
    useFailureNoticesStore.getState().push('agent-1 did not stop')
    const [notice] = useFailureNoticesStore.getState().notices
    useFailureNoticesStore.getState().dismiss(notice.id)
    expect(useFailureNoticesStore.getState().notices).toEqual([])
  })
})

describe('sidebar row markers', () => {
  it('in its own window: by path, or by agent id after a move', () => {
    const windows = [{ filePath: FILE_1, agentId: AGENT_1 }]
    expect(isInAgentWindow(windows, FILE_1)).toBe(true)
    expect(isInAgentWindow(windows, '/moved/agent-1.adf', AGENT_1)).toBe(true)
    expect(isInAgentWindow(windows, FILE_2, AGENT_2)).toBe(false)
    expect(isInAgentWindow([], FILE_1, AGENT_1)).toBe(false)
  })

  it('an accepted review clears the marker on a nested row too', () => {
    useTrackedDirsStore.setState({
      directories: ['/agents'],
      filesByDir: {
        '/agents': [
          { filePath: FILE_1, fileName: 'agent-1.adf', agentId: AGENT_1, reviewed: false },
          { filePath: '/agents/team', fileName: 'team', isDirectory: true, children: [{ filePath: FILE_2, fileName: 'agent-2.adf', agentId: AGENT_2, reviewed: false }] },
        ],
      },
    })
    const before = useTrackedDirsStore.getState().filesByDir['/agents']
    useTrackedDirsStore.getState().updateFileEntry(FILE_2, { reviewed: true })
    const after = useTrackedDirsStore.getState().filesByDir['/agents']
    expect(after[1].children?.[0].reviewed).toBe(true)
    // The untouched row keeps its identity (memoised rows do not re-render).
    expect(after[0]).toBe(before[0])
    // No change, no new state.
    useTrackedDirsStore.getState().updateFileEntry(FILE_2, { reviewed: true })
    expect(useTrackedDirsStore.getState().filesByDir['/agents']).toBe(after)
  })
})

describe('shortcut labels', () => {
  it('as each platform writes them', () => {
    expect(shortcutLabel(',', { mod: true }, false)).toBe('Ctrl+,')
    expect(shortcutLabel('W', { mod: true, shift: true }, false)).toBe('Ctrl+Shift+W')
    expect(shortcutLabel(',', { mod: true }, true)).toBe('⌘,')
    expect(shortcutLabel('W', { mod: true, shift: true }, true)).toBe('⇧⌘W')
  })
})
