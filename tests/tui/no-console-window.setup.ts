import { vi } from 'vitest'

// No TUI test may open a console window on Windows. Tests run from a shell
// with no console (background agents), so every console program they start
// gets its own window on the owner's desktop.
//
// - ink sizes a non-TTY stdout with terminal-size, which falls back to
//   running `tput` (Git Bash puts it on PATH) without windowsHide. A size in
//   the environment is read first; 80x24 is terminal-size's own fallback.
// - The $EDITOR helper starts the editor through cmd.exe with
//   windowsHide: false on purpose (a real terminal hands it its console);
//   the test editors run hidden.
process.env.COLUMNS ??= '80'
process.env.LINES ??= '24'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((command: string, args?: readonly string[] | object, options?: object) => Array.isArray(args)
    ? real.spawn(command, args, { ...options, windowsHide: true })
    : real.spawn(command, { ...(args as object | undefined), windowsHide: true })) as typeof real.spawn
  return { ...real, spawn, default: { ...real, spawn } }
})
