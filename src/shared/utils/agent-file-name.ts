/**
 * The agent file-name rule (an agent's name is its file's stem): embedded
 * Studio's rename, quick-create and name sync (ipc/index.ts), and since
 * W5-D2 the daemon's create, rename and import and Studio's daemon-mode
 * handlers, so both backends accept the same names.
 *
 * Not empty, none of the characters Windows refuses in a file name (a
 * superset of POSIX's), no trailing dot or space. No length limit and no
 * reserved names here: the file system has the last word. The daemon still
 * refuses a path through a Windows device name (file-ops.ts requireAdfPath).
 */

/** Characters not allowed in file names on Windows (superset of POSIX). */
export const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

export function isValidAgentFileName(name: string): boolean {
  return name.length > 0 && !INVALID_FILENAME_CHARS.test(name) && !name.endsWith('.') && !name.endsWith(' ')
}

/** Windows reserved device names (with any extension). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * A Windows device name (CON, NUL, COM1, …, with any extension). The daemon
 * refuses an agent named so on every OS, where embedded Studio leaves it to
 * the file system: Windows cannot reliably create or open such a file, and
 * one made elsewhere cannot travel to a Windows machine (W5-D2, deliberate).
 */
export function isWindowsDeviceName(name: string): boolean {
  return DEVICE_NAME.test(name.split('.')[0].trim())
}

/**
 * The daemon's answer to a name an agent file cannot take (create, rename,
 * import, name sync): the embedded rule, then no Windows device name. Null
 * when the name is fine.
 */
export function agentFileNameProblem(name: string): string | null {
  if (!isValidAgentFileName(name)) return 'Name contains characters not allowed in file names.'
  if (isWindowsDeviceName(name)) return `"${name}" is a Windows device name (CON, NUL, COM1, …), which no file can be named on Windows. Choose another name.`
  return null
}
