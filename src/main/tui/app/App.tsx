import { useCallback, useMemo } from 'react'
import { useApp } from 'ink'
import { ThemeContext, type Theme } from './theme'
import { KeyRouterProvider, createKeyRouter } from './keys'
import { ShellContext } from './shell-context'
import { Shell } from './Shell'
import { StoreProvider, type TuiStore } from '../state/store'
import { collectCommands } from '../commands/registry'
import { BUILTIN_COMMANDS } from '../commands/builtin/index'
import type { CommandContribution } from '../commands/types'
import { VIEWS } from '../views/registry'
import type { ViewDefinition } from '../views/types'

export interface AppProps {
  store: TuiStore
  theme: Theme
  /** Override for tests; defaults to views/registry.ts. */
  views?: ViewDefinition[]
  builtins?: CommandContribution[]
  /** Called after the UI asks to exit, before ink unmounts. */
  onExit?: () => void
  /** Leave this many terminal rows unused at the bottom. */
  reserveRows?: number
  /** Leave this many terminal columns unused on the right. */
  reserveColumns?: number
}

export function App({ store, theme, views = VIEWS, builtins = [BUILTIN_COMMANDS], onExit, reserveRows = 0, reserveColumns = 0 }: AppProps) {
  const app = useApp()
  const router = useMemo(() => createKeyRouter(), [])
  const registry = useMemo(() => collectCommands(views, builtins), [views, builtins])
  const exit = useCallback(() => {
    onExit?.()
    app.exit()
  }, [app, onExit])
  const shell = useMemo(() => ({ views, registry, exit, reserveRows, reserveColumns }), [views, registry, exit, reserveRows, reserveColumns])
  return (
    <ThemeContext.Provider value={theme}>
      <StoreProvider store={store}>
        <KeyRouterProvider router={router}>
          <ShellContext.Provider value={shell}>
            <Shell />
          </ShellContext.Provider>
        </KeyRouterProvider>
      </StoreProvider>
    </ThemeContext.Provider>
  )
}
