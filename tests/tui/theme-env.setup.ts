// TUI snapshots and render tests need a stable terminal profile, independent
// of the shell that launched Vitest. ASCII and monochrome behavior is tested
// by passing those options explicitly to createTheme.
process.env.TERM = 'xterm-256color'
delete process.env.NO_COLOR
