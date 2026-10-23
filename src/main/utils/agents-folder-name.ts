/**
 * The default agents folder's name under Documents: `adf-agents`, or
 * `adf-agents-<n>` for an isolated instance (ADF_INSTANCE=n, index.ts), so
 * a demo or test instance does not show or fill the everyday folder.
 */
export function defaultAgentsFolderName(env: NodeJS.ProcessEnv = process.env): string {
  const instance = env.ADF_INSTANCE?.trim().replace(/[^\w.-]/g, '_')
  return instance ? `adf-agents-${instance}` : 'adf-agents'
}
