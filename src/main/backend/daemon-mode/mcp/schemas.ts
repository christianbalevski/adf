/**
 * The argument schemas of the MCP and adapter handlers: the embedded ones
 * themselves (ipc/mcp-adapter-args.ts, extracted under rule E1), so a
 * daemon-mode handler refuses exactly what the embedded one refuses, with the
 * same message.
 */
export {
  AdapterAttachArgs, AdapterCredentialGetArgs, AdapterCredentialSetArgs, AdapterDetachArgs, AdapterListFilesArgs,
  AdapterPackageArgs, AdapterTypeArgs, McpAttachArgs, McpCredentialGetArgs, McpCredentialListArgs, McpCredentialSetArgs,
  McpDetachArgs, McpNameArgs, McpPackageArgs, McpUninstallArgs, mcpAttachEntry, validateMcpArgs,
} from '../../../ipc/mcp-adapter-args'
