export const COMMAND_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/
export const RESERVED_COMMAND_NAMES = ['compact', 'clear', 'skills', 'idle', 'hibernate', 'stop', 'off'] as const

export function parseLambdaRef(ref: string): { file: string; fn: string } | { error: string } {
  const colon = typeof ref === 'string' ? ref.lastIndexOf(':') : -1
  const file = colon > 0 ? ref.slice(0, colon) : ''
  const fn = colon > 0 ? ref.slice(colon + 1) : ''
  if (!/\.(ts|js|mjs)$/.test(file) || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(fn)) {
    return { error: `Lambda must be "path/file.ts:functionName" (got "${ref}").` }
  }
  return { file, fn }
}

export interface AgentCommandIssue { index: number; field: string; message: string }
export function validateAgentCommands(commands: unknown): AgentCommandIssue[] {
  if (!Array.isArray(commands)) return [{ index: -1, field: 'commands', message: 'Commands must be an array. Replace the malformed value with a list of commands.' }]
  const issues: AgentCommandIssue[] = []
  const seen = new Set<string>()
  commands.forEach((command, index) => {
    const add = (field: string, message: string): void => { issues.push({ index, field, message }) }
    if (!command || typeof command !== 'object') { add('name', 'Provide a command with a name, description and lambda.'); return }
    const name = command.name
    if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name)) add('name', `Command "${name}" is not a valid name: use 1–32 lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit.`)
    if ((RESERVED_COMMAND_NAMES as readonly string[]).includes(name)) add('name', `"/${name}" is a built-in command. Pick another name.`)
    if (typeof name === 'string') {
      const key = name.toLowerCase()
      if (seen.has(key)) add('name', `Command "${name}" is duplicated. Pick a unique name.`)
      seen.add(key)
    }
    if (typeof command.description !== 'string' || command.description.length < 1 || command.description.length > 200) add('description', 'Description must contain 1–200 characters.')
    if (command.usage !== undefined && (typeof command.usage !== 'string' || command.usage.length > 100)) add('usage', 'Usage must contain at most 100 characters.')
    const ref = parseLambdaRef(command.lambda)
    if ('error' in ref) add('lambda', ref.error)
  })
  if (commands.length > 64) issues.push({ index: 64, field: 'name', message: 'Register at most 64 commands.' })
  return issues
}

export function splitArgv(args: string): string[] { return args.split(/\s+/).filter(Boolean) }
export function parseAuthorizeToken(args: string): { args: string; authorize: boolean } {
  let authorize = false
  const tokens = splitArgv(args).filter(token => {
    if (token !== '!authorize') return true
    authorize = true
    return false
  }).map(token => token === '\\!authorize' ? '!authorize' : token)
  return { args: tokens.join(' '), authorize }
}
