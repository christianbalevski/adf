import { EventEmitter } from 'events'
import { basename, dirname, join, sep } from 'path'
import { nanoid as _nanoid } from 'nanoid'
const nanoid = () => _nanoid(10)
import { MessageBus, type MessageBusLogEntry } from './message-bus'
import { ToolRegistry } from '../tools/tool-registry'
import { SendMessageTool } from '../tools/built-in/msg-send.tool'
import { AgentDiscoverTool, type DirectoryEntry as AgentDiscoverEntry } from '../tools/built-in/agent-discover.tool'
import { InboxCheckTool, InboxReadTool, InboxUpdateTool, WsConnectTool, WsDisconnectTool, WsConnectionsTool, WsSendTool } from '../tools/built-in'
import { deriveHandle } from '../utils/handle'
import type { AgentSession } from './agent-session'
import type { TriggerEvaluator } from './trigger-evaluator'
import type { AdfCallHandler } from './adf-call-handler'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig, StoredAttachment, AlfMessage, AlfAgentCard, EgressContext } from '../../shared/types/adf-v02.types'
import { buildAlfMessage, tombstoneMessage, flattenMessageToInbox } from '../utils/alf-message'
import { AlfPipeline, createDefaultPipeline } from '../services/alf-pipeline'
import { buildAgentCard } from '../services/mesh-server'
import type { AlfPipelineContext } from '../services/alf-pipeline'
import type { AgentMessage } from '../../shared/types/message.types'
import type { AgentExecutor } from './agent-executor'
import type {
  AgentState,
  MeshAgentStatus,
  MeshEvent
} from '../../shared/types/ipc.types'
import type { ChannelAdapterManager } from '../services/channel-adapter-manager'
import type { CodeSandboxService } from './code-sandbox'
import type { OutboundMessage } from '../../shared/types/channel-adapter.types'
import { executeMiddlewareChain } from '../services/middleware-executor'
import { resolveTransport } from '../services/transport-resolve'
import type { WsConnectionManager, WsManagerDelegate } from '../services/ws-connection-manager'
import { didToPublicKey, rawPublicKeyToSpki } from '../crypto/identity-crypto'
import { ancestorScope, permits, denialReason } from './scope-resolver'
import type { MdnsService, DiscoveredRuntime } from '../services/mdns-service'
import type { DirectoryFetchCache } from '../services/directory-fetch-cache'

interface RegisteredAgent {
  filePath: string
  trackedDirRoot: string  // The tracked directory this agent belongs to
  handle: string
  config: AgentConfig
  toolRegistry: ToolRegistry
  workspace: AdfWorkspace
  session: AgentSession
  triggerEvaluator: TriggerEvaluator | null
  isForeground: boolean
  messageUnsubscribe: () => void
  // Required-nullable: callers must explicitly decide whether the agent has a
  // serving-capable runtime attached. Null means "registered on the mesh for
  // messaging only — serving API routes will 503". Every call site passes an
  // explicit value so a missing wiring fails at compile time, not at runtime.
  executor: AgentExecutor | null
  adfCallHandler: AdfCallHandler | null
  codeSandboxService: CodeSandboxService | null
}

export interface ServableAgent {
  handle: string
  filePath: string
  config: AgentConfig
  workspace: AdfWorkspace
  triggerEvaluator: TriggerEvaluator | null
  adfCallHandler: AdfCallHandler | null
  codeSandboxService: CodeSandboxService | null
  getSigningKey?: () => Buffer | null
}

/**
 * Check whether a given identifier (DID) passes an allow/block list filter.
 * If allow_list is non-empty, only identifiers in it pass.
 * Otherwise if block_list is non-empty, identifiers in it are rejected.
 * With neither list set, everything passes.
 */
function isAllowedByList(
  identifier: string,
  allowList?: string[],
  blockList?: string[]
): boolean {
  if (allowList && allowList.length > 0) return allowList.includes(identifier)
  if (blockList && blockList.length > 0) return !blockList.includes(identifier)
  return true
}

/**
 * Manages inter-agent messaging only — no agent lifecycle.
 * Agents are registered/unregistered by the IPC coordinator.
 * When mesh is enabled, registered agents get communication tools
 * (send_message, list_agents) and can exchange messages via the MessageBus.
 */
export class MeshManager extends EventEmitter {
  private messageBus: MessageBus
  private registeredAgents: Map<string, RegisteredAgent> = new Map()
  private handleToFilePath: Map<string, string> = new Map()
  private enabled = false
  private trackedDirectories: string[] = []
  private adapterManagers: Map<string, ChannelAdapterManager> = new Map()
  private meshHost = '127.0.0.1'
  private meshPort = 7295
  private pipeline: AlfPipeline
  private derivedKeys: Map<string, Buffer> = new Map()
  private wsConnectionManager: WsConnectionManager | null = null
  private mdnsService: MdnsService | null = null
  private directoryFetchCache: DirectoryFetchCache | null = null

  constructor(trackedDirectories: string[] = []) {
    super()
    this.messageBus = new MessageBus()
    this.trackedDirectories = trackedDirectories
    this.pipeline = createDefaultPipeline()
  }

  /** Store a derived key for an agent so the pipeline can access signing keys. */
  setDerivedKey(filePath: string, key: Buffer): void {
    this.derivedKeys.set(filePath, key)
  }

  /** Clear a derived key (e.g. on lock or agent close). */
  clearDerivedKey(filePath: string): void {
    this.derivedKeys.delete(filePath)
  }

  /**
   * Update the list of tracked directories (called when settings change).
   */
  setTrackedDirectories(dirs: string[]): void {
    this.trackedDirectories = dirs
  }

  /**
   * Set the mesh server host/port (called when MeshServer starts).
   */
  setMeshServerAddress(host: string, port: number): void {
    this.meshHost = host === '0.0.0.0' ? '127.0.0.1' : host
    this.meshPort = port
  }

  setWsConnectionManager(manager: WsConnectionManager | null): void {
    this.wsConnectionManager = manager
  }

  createWsDelegate(): WsManagerDelegate {
    return {
      getAgentDid: (fp) => this.registeredAgents.get(fp)?.workspace.getDid() ?? null,
      getPrivateKey: (fp) => {
        // Check derived keys first (password-protected agents)
        const derived = this.derivedKeys.get(fp)
        if (derived) return derived
        // Fall back to workspace signing keys (unprotected agents)
        const workspace = this.registeredAgents.get(fp)?.workspace
        if (!workspace) return null
        return workspace.getSigningKeys(null)?.privateKey ?? null
      },
      getPublicKey: (did) => {
        const raw = didToPublicKey(did)
        return raw ? rawPublicKeyToSpki(raw) : null
      },
      processIngressMessage: (fp, msg) => this.processIngressMessage(fp, msg),
      getCodeSandbox: (fp) => this.registeredAgents.get(fp)?.codeSandboxService ?? null,
      getAdfCallHandler: (fp) => this.registeredAgents.get(fp)?.adfCallHandler ?? null,
      getWorkspace: (fp) => this.registeredAgents.get(fp)?.workspace ?? null,
      getToolConfig: (fp) => {
        const h = this.registeredAgents.get(fp)?.adfCallHandler
        return h ? { enabledTools: h.getEnabledToolNames(), hilTools: h.getHilToolNames() } : null
      },
      getAllowUnsigned: (fp) => this.registeredAgents.get(fp)?.config.security?.allow_unsigned ?? false
    }
  }

  /**
   * Find the tracked directory root for a given agent file path.
   * Returns the longest matching tracked directory, or null if not in any tracked dir.
   */
  private findTrackedDirRoot(filePath: string): string | null {
    let longestMatch: string | null = null
    for (const dir of this.trackedDirectories) {
      if (filePath.startsWith(dir + '/') || filePath.startsWith(dir + '\\')) {
        if (!longestMatch || dir.length > longestMatch.length) {
          longestMatch = dir
        }
      }
    }
    return longestMatch
  }


  /**
   * Resolve a relative agent name to an absolute file path.
   */
  private resolveAgentPath(trackedDirRoot: string, agentName: string): string {
    return join(trackedDirRoot, `${agentName}.adf`)
  }

  /**
   * Associate a ChannelAdapterManager with an agent for outbound routing.
   */
  setAdapterManager(filePath: string, manager: ChannelAdapterManager): void {
    this.adapterManagers.set(filePath, manager)
  }

  /**
   * Remove the adapter manager association for an agent.
   */
  removeAdapterManager(filePath: string): void {
    this.adapterManagers.delete(filePath)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getMessageBus(): MessageBus {
    return this.messageBus
  }

  /**
   * Enable mesh: create message bus, set enabled flag.
   * Caller is responsible for registering running agents afterward.
   */
  enableMesh(): void {
    this.enabled = true
    this.messageBus = new MessageBus()
    console.log('[Mesh] Enabled')
  }

  /**
   * Disable mesh: unregister all agents (removes comm tools), tear down bus.
   * Agents keep running — only messaging is removed.
   */
  disableMesh(): void {
    // Unregister all agents (removes their comm tools)
    for (const filePath of Array.from(this.registeredAgents.keys())) {
      this.unregisterAgent(filePath)
    }
    this.enabled = false
    console.log('[Mesh] Disabled')
  }

  /**
   * Register an agent on the mesh. Injects send_message + list_agents tools
   * into the agent's tool registry and subscribes to the message bus.
   */
  /**
   * Register an agent on the mesh. `executor`, `adfCallHandler`, and
   * `codeSandboxService` are required-nullable: callers must pass a concrete
   * ref or explicit `null`. Registering with `null` means the agent
   * participates in messaging but cannot serve HTTP API routes — requests to
   * `serving.api` routes will 503. This shape forces every call site to make
   * the choice consciously (regression guard for the /health 503 bug).
   */
  registerAgent(
    filePath: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
    workspace: AdfWorkspace,
    session: AgentSession,
    triggerEvaluator: TriggerEvaluator,
    isForeground: boolean,
    isMessageTriggeredFn: (() => boolean) | null,
    executor: AgentExecutor | null,
    adfCallHandler: AdfCallHandler | null,
    codeSandboxService: CodeSandboxService | null
  ): void {
    if (!this.enabled) return
    if (this.registeredAgents.has(filePath)) {
      // Defensive: a caller may re-invoke registerAgent with a fresh
      // toolRegistry (e.g. AGENT_START rebuilds the registry but the agent
      // was never explicitly unregistered first). Without this top-up the new
      // registry would be missing msg_send / agent_discover / ws_* and
      // adfCallHandler.handleCall would reject mesh tool calls with the
      // misleading "mesh not enabled" error. registerCommunicationTools
      // is idempotent — it skips tools already present.
      this.registerCommunicationTools(filePath, config, toolRegistry, isMessageTriggeredFn ?? undefined)
      return
    }

    // Derive handle and disambiguate collisions (sage, sage-1, sage-2, ...)
    let handle = config.handle || deriveHandle(filePath)
    if (this.handleToFilePath.has(handle)) {
      const base = handle
      let suffix = 1
      while (this.handleToFilePath.has(`${base}-${suffix}`)) suffix++
      handle = `${base}-${suffix}`
      console.warn(`[Mesh] Handle "${base}" already taken, using "${handle}" for ${filePath}`)
    }
    this.handleToFilePath.set(handle, filePath)

    // Ensure messaging config exists so the agent can participate
    if (!config.messaging) {
      config.messaging = { receive: false, mode: 'respond_only' }
    }
    // Ensure mode is set (for backward compatibility)
    if (!config.messaging.mode) {
      config.messaging.mode = 'respond_only'
    }
    config.messaging.receive = true

    // Ensure communication tools are available in config and runtime registry.
    this.ensureCommunicationTools(config)
    this.registerCommunicationTools(filePath, config, toolRegistry, isMessageTriggeredFn ?? undefined)

    // Register on message bus (channels dropped — all agents receive broadcasts)
    this.messageBus.registerAgent(filePath, ['*'])

    const unsubscribe = this.messageBus.onMessage(filePath, (message, mentioned) => {
      this.handleIncomingMessage(filePath, message, mentioned)
    })

    // Determine which tracked directory this agent belongs to
    const trackedDirRoot = this.findTrackedDirRoot(filePath) || dirname(filePath)

    this.registeredAgents.set(filePath, {
      filePath,
      trackedDirRoot,
      handle,
      config,
      toolRegistry,
      workspace,
      session,
      triggerEvaluator,
      isForeground,
      messageUnsubscribe: unsubscribe,
      executor,
      adfCallHandler,
      codeSandboxService
    })

    // Inject mesh context into executor's system prompt
    if (executor) {
      executor.setMeshContext(() => this.getAgentDirectory(filePath))
    }

    // Register card builder on workspace so tools can access the signed card
    workspace._cardBuilder = () => {
      const reg = this.registeredAgents.get(filePath)
      if (!reg) return null
      // _cardBuilder is invoked by in-process tools/lambdas — serve loopback URLs.
      // HTTP-served cards (via /{handle}/mesh/card and /mesh/directory) go through
      // the route handlers and get requester-aware hosts instead.
      return buildAgentCard({
        handle: reg.handle,
        filePath: reg.filePath,
        config: reg.config,
        workspace: reg.workspace,
        triggerEvaluator: reg.triggerEvaluator,
        adfCallHandler: reg.adfCallHandler,
        codeSandboxService: reg.codeSandboxService,
        getSigningKey: () => reg.workspace.getSigningKeys(this.derivedKeys.get(filePath) ?? null)?.privateKey ?? null
      }, '127.0.0.1', this.meshPort)
    }

    this.emitMeshEvent({
      type: 'agent_joined',
      payload: { filePath, state: 'idle' },
      timestamp: Date.now()
    })

    // Start outbound WS connections
    if (this.wsConnectionManager && config.ws_connections?.length) {
      this.wsConnectionManager.registerAgent(filePath, config.ws_connections)
    }

    console.log(`[Mesh] Registered ${basename(filePath, '.adf')} (${isForeground ? 'foreground' : 'background'})`)
  }

  /**
   * Register an agent for HTTP serving without requiring a TriggerEvaluator.
   *
   * The daemon uses this while it grows toward full Studio parity: public files,
   * shared files, agent cards, API routes, and outbound mesh messaging work
   * immediately, while trigger-driven inbox handling remains optional until the
   * daemon owns a TriggerEvaluator for each agent.
   */
  registerServableAgent(
    filePath: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
    workspace: AdfWorkspace,
    session: AgentSession,
    executor: AgentExecutor | null,
    adfCallHandler: AdfCallHandler | null,
    codeSandboxService: CodeSandboxService | null,
    triggerEvaluator: TriggerEvaluator | null
  ): void {
    if (this.registeredAgents.has(filePath)) return

    let handle = config.handle || deriveHandle(filePath)
    if (this.handleToFilePath.has(handle)) {
      const base = handle
      let suffix = 1
      while (this.handleToFilePath.has(`${base}-${suffix}`)) suffix++
      handle = `${base}-${suffix}`
      console.warn(`[Mesh] Handle "${base}" already taken, using "${handle}" for ${filePath}`)
    }
    this.handleToFilePath.set(handle, filePath)

    if (this.enabled) {
      if (!config.messaging) {
        config.messaging = { receive: false, mode: 'respond_only' }
      }
      if (!config.messaging.mode) {
        config.messaging.mode = 'respond_only'
      }
      config.messaging.receive = true
      this.ensureCommunicationTools(config)
      this.registerCommunicationTools(filePath, config, toolRegistry, () => false)
    }

    const trackedDirRoot = this.findTrackedDirRoot(filePath) || dirname(filePath)

    this.registeredAgents.set(filePath, {
      filePath,
      trackedDirRoot,
      handle,
      config,
      toolRegistry,
      workspace,
      session,
      triggerEvaluator,
      isForeground: false,
      messageUnsubscribe: () => {},
      executor,
      adfCallHandler,
      codeSandboxService,
    })

    if (executor) {
      executor.setMeshContext(() => this.getAgentDirectory(filePath))
    }

    workspace._cardBuilder = () => {
      const reg = this.registeredAgents.get(filePath)
      if (!reg) return null
      // _cardBuilder is invoked by in-process tools/lambdas — serve loopback URLs.
      // HTTP-served cards (via /{handle}/mesh/card and /mesh/directory) go through
      // the route handlers and get requester-aware hosts instead.
      return buildAgentCard({
        handle: reg.handle,
        filePath: reg.filePath,
        config: reg.config,
        workspace: reg.workspace,
        triggerEvaluator: reg.triggerEvaluator,
        adfCallHandler: reg.adfCallHandler,
        codeSandboxService: reg.codeSandboxService,
        getSigningKey: () => reg.workspace.getSigningKeys(this.derivedKeys.get(filePath) ?? null)?.privateKey ?? null
      }, '127.0.0.1', this.meshPort)
    }

    this.emitMeshEvent({
      type: 'agent_joined',
      payload: { filePath, state: 'idle' },
      timestamp: Date.now()
    })

    if (this.wsConnectionManager && config.ws_connections?.length) {
      this.wsConnectionManager.registerAgent(filePath, config.ws_connections)
    }

    console.log(`[Mesh] Registered ${basename(filePath, '.adf')} (servable)`)
  }

  /**
   * Update the cached config for a registered agent (e.g. after sys_update_config).
   * Keeps the mesh-served agent card in sync without requiring a restart.
   */
  updateAgentConfig(filePath: string, config: AgentConfig): void {
    const reg = this.registeredAgents.get(filePath)
    if (reg) reg.config = config
  }

  /**
   * Unregister an agent from mesh. Removes comm tools via toolRegistry.unregister().
   * The agent keeps running — only messaging is removed.
   */
  unregisterAgent(filePath: string, options?: { keepWsConnections?: boolean }): void {
    const reg = this.registeredAgents.get(filePath)
    if (!reg) return

    // Clean up handle mapping
    if (this.handleToFilePath.get(reg.handle) === filePath) {
      this.handleToFilePath.delete(reg.handle)
    }

    reg.messageUnsubscribe()
    this.messageBus.unregisterAgent(filePath)

    // Clear mesh context from executor's system prompt
    if (reg.executor) {
      reg.executor.clearMeshContext()
    }

    // Clean up WS connections (skip if transitioning to background — connections survive)
    if (this.wsConnectionManager && !options?.keepWsConnections) {
      this.wsConnectionManager.unregisterAgent(filePath)
    }

    // Remove communication tools from the agent's runtime registry.
    // Config tool declarations are left intact so user toggles persist to disk.
    reg.toolRegistry.unregister('msg_send')
    reg.toolRegistry.unregister('agent_discover')
    reg.toolRegistry.unregister('msg_list')
    reg.toolRegistry.unregister('msg_read')
    reg.toolRegistry.unregister('msg_update')
    reg.toolRegistry.unregister('ws_connect')
    reg.toolRegistry.unregister('ws_disconnect')
    reg.toolRegistry.unregister('ws_connections')
    reg.toolRegistry.unregister('ws_send')

    // Clear card builder from workspace
    reg.workspace._cardBuilder = undefined

    this.registeredAgents.delete(filePath)

    this.emitMeshEvent({
      type: 'agent_left',
      payload: { filePath },
      timestamp: Date.now()
    })

    console.log(`[Mesh] Unregistered ${basename(filePath, '.adf')}`)
  }

  /**
   * Handle an incoming message for a specific agent.
   */
  handleIncomingMessage(filePath: string, message: AgentMessage, mentioned: boolean): void {
    const senderHandle = this.resolveAgentHandle(message.from)
    const reg = this.registeredAgents.get(filePath)
    if (!reg) {
      console.warn(`[Mesh] handleIncomingMessage: no agent found for ${filePath}`)
      return
    }

    // Resolve sender DID for allow/block list check
    const senderReg = this.registeredAgents.get(message.from)
    const senderDid = senderReg?.workspace.getDid() ?? message.from

    // Inbound allow/block list check (DID-based)
    const { allow_list, block_list } = reg.config.messaging ?? {}
    if (!senderDid && (allow_list?.length || block_list?.length)) {
      console.log(`[Mesh] Inbound message from "${senderHandle}" blocked: sender DID not available`)
      return
    }
    if (senderDid && !isAllowedByList(senderDid, allow_list, block_list)) {
      console.log(`[Mesh] Inbound message from "${senderHandle}" blocked by recipient's allow/block list`)
      return
    }

    const recipientName = basename(filePath, '.adf')
    if (process.env.NODE_ENV !== 'production') console.log(`[Mesh] Delivering message: ${senderHandle} -> ${recipientName}`)
    const msgContent = String(message.content)

    // Write to inbox
    const inboxId = reg.workspace.addToInbox({
      from: senderDid,
      content: msgContent,
      parent_id: message.replyTo,
      source: 'mesh',
      received_at: message.timestamp,
      status: 'unread'
    })

    // Emit inbox_updated so renderer can refresh
    const unread = reg.workspace.getInbox('unread')
    const read = reg.workspace.getInbox('read')
    this.emit('inbox_updated', { filePath, inbox: [...unread, ...read] })

    // Notify renderer for foreground agents
    if (reg.isForeground) {
      this.emit('foreground_incoming', {
        filePath,
        fromAgent: senderHandle,
        toAgent: recipientName,
        content: msgContent
      })
    }

    // Fire on_inbox trigger with source and message metadata
    reg.triggerEvaluator?.onInbox(senderDid, msgContent, {
      mentioned, source: 'mesh',
      messageId: inboxId,
      parentId: message.replyTo
    })
  }

  /**
   * Process an ALF message through the ingress pipeline and store in inbox.
   * Used by both local delivery and WS cold-path callback.
   */
  async processIngressMessage(
    recipientFilePath: string,
    message: AlfMessage,
    returnPath?: string,
    _source: string = 'mesh'
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const recipientReg = this.registeredAgents.get(recipientFilePath)
    if (!recipientReg) {
      return { success: false, error: 'Recipient not registered' }
    }

    try {
      const senderDid = message.from
      const recipientDid = recipientReg.workspace.getDid() ?? recipientReg.config.id

      // Run ingress pipeline (signature verification)
      const ingressCtx: AlfPipelineContext = {
        direction: 'ingress',
        workspace: recipientReg.workspace,
        localDid: recipientDid,
        remoteDid: senderDid,
        isLocal: false,
        security: recipientReg.config.security ?? { allow_unsigned: true },
        derivedKey: this.derivedKeys.get(recipientFilePath) ?? null
      }
      const ingressResult = await this.pipeline.processIngress(message, ingressCtx)
      if (ingressResult.rejected) {
        return { success: false, error: `Ingress rejected: ${ingressResult.rejected.reason}` }
      }
      message = ingressResult.data

      // Inbound allow/block list check (DID-based)
      const { allow_list, block_list } = recipientReg.config.messaging ?? {}
      if (!senderDid && (allow_list?.length || block_list?.length)) {
        return { success: false, error: 'Sender DID not available; cannot evaluate allow/block list' }
      }
      if (senderDid && !isAllowedByList(senderDid, allow_list, block_list)) {
        return { success: false, error: 'Sender blocked by allow/block list' }
      }

      // Run inbox custom middleware
      const inboxMw = recipientReg.config.security?.middleware?.inbox
      if (inboxMw?.length && recipientReg.codeSandboxService && recipientReg.adfCallHandler) {
        const mwResult = await executeMiddlewareChain(
          inboxMw,
          { point: 'inbox', data: message, meta: {} },
          recipientReg.workspace,
          recipientReg.codeSandboxService,
          recipientReg.adfCallHandler,
          recipientReg.config.id
        )
        if (mwResult.rejected) {
          return { success: false, error: `Inbox middleware rejected: ${mwResult.rejected.reason}` }
        }
        if (mwResult.data) {
          message = mwResult.data as AlfMessage
        }
      }

      const receivedAt = Date.now()

      // Audit: capture full message (already has inline data from wire) before flattening
      try { recipientReg.workspace.auditMessage('inbox', JSON.stringify(message), receivedAt) } catch { /* best-effort */ }

      const flattened = flattenMessageToInbox(message, receivedAt)
      if (returnPath) flattened.return_path = returnPath
      const inboxId = recipientReg.workspace.addToInbox(flattened)

      // Fire on_inbox trigger
      const content = typeof message.payload.content === 'string'
        ? message.payload.content
        : JSON.stringify(message.payload.content)
      recipientReg.triggerEvaluator?.onInbox(senderDid, content, {
        mentioned: true,
        source: 'mesh',
        messageId: inboxId,
        parentId: flattened.parent_id,
        threadId: flattened.thread_id
      })

      // Emit inbox_updated so renderer can refresh
      const unread = recipientReg.workspace.getInbox('unread')
      const read = recipientReg.workspace.getInbox('read')
      this.emit('inbox_updated', { filePath: recipientFilePath, inbox: [...unread, ...read] })

      return { success: true, messageId: inboxId }
    } catch (error) {
      return { success: false, error: `Ingress processing failed: ${error}` }
    }
  }

  /**
   * Send a message to a single recipient identified by DID + delivery address.
   * Uses local fast path for same-runtime agents, HTTP POST for remote.
   */
  async sendMessage(
    fromFilePath: string,
    recipient: string,
    address: string | undefined,
    content: string,
    subject?: string,
    threadId?: string,
    parentId?: string,
    attachments?: string[],
    meta?: Record<string, unknown>,
    messageMeta?: Record<string, unknown>
  ): Promise<{ success: boolean; messageId?: string; statusCode?: number; error?: string }> {
    console.log(`[Mesh] sendMessage: from=${fromFilePath} to="${recipient}" address="${address}"`)

    // Get sender's registration
    const senderReg = this.registeredAgents.get(fromFilePath)
    if (!senderReg) {
      return { success: false, error: 'Sender agent not registered in mesh' }
    }

    const senderConfig = senderReg.config
    const senderHandle = senderReg.handle
    // Identity is opt-in: when the agent has no DID, send as the handle. Receivers
    // discriminate by the `did:` prefix and skip signature verification for bare handles.
    // Use `||` not `??` — getDid() can return an empty string when no keypair is configured.
    const senderDid = senderReg.workspace.getDid() || senderHandle
    const network = senderConfig.messaging?.network ?? 'devnet'

    // --- Adapter routing: recipient matching `{adapterType}:{id}` ---
    const adapterManager = this.adapterManagers.get(fromFilePath)
    const colonIdx = recipient.indexOf(':')
    const isAdapterRecipient = colonIdx > 0 && !recipient.startsWith('did:')
    if (isAdapterRecipient) {
      const adapterType = recipient.slice(0, colonIdx)
      const recipientId = recipient.slice(colonIdx + 1)
      if (adapterManager?.isConnected(adapterType)) {
        return this.sendViaAdapter(senderReg, adapterManager, adapterType, recipientId, recipient, content, subject, threadId, parentId, attachments, messageMeta)
      }
      // Adapter recipient but routing failed — return specific error instead of falling through to mesh
      if (!adapterManager) {
        const err = `No adapter manager configured for this agent. Cannot deliver to ${adapterType} recipient.`
        console.warn(`[Mesh] No adapter manager for agent ${fromFilePath} — cannot route to ${adapterType}:${recipientId}`)
        try { senderReg.workspace.insertLog('error', 'mesh', 'adapter_send_failed', adapterType, err) } catch { /* non-fatal */ }
        return { success: false, error: err }
      }
      const status = adapterManager.getStatus(adapterType)
      const err = `Adapter "${adapterType}" is not connected (status: ${status ?? 'not running'}). Message cannot be delivered.`
      console.warn(`[Mesh] Adapter "${adapterType}" not connected (status: ${status ?? 'not found'}) — cannot deliver to ${recipientId}`)
      try { senderReg.workspace.insertLog('warn', 'mesh', 'adapter_send_failed', adapterType, err) } catch { /* non-fatal */ }
      return { success: false, error: err }
    }

    // Also check reply routing: if parentId references an inbox message from an adapter
    if (adapterManager && parentId && !address) {
      const inboxMessages = senderReg.workspace.getInbox()
      const parentMsg = inboxMessages.find(m => m.id === parentId)
      if (parentMsg && parentMsg.source && parentMsg.source !== 'mesh') {
        if (adapterManager.isConnected(parentMsg.source)) {
          const chatId = (parentMsg.source_context as Record<string, unknown> | undefined)?.chat_id
          const recipientId = chatId ? String(chatId) : parentMsg.from.replace(`${parentMsg.source}:`, '')
          return this.sendViaAdapter(senderReg, adapterManager, parentMsg.source, recipientId, `${parentMsg.source}:${recipientId}`, content, subject, threadId, parentId, attachments, messageMeta)
        }
        // Parent is from an adapter but the adapter isn't connected
        const status = adapterManager.getStatus(parentMsg.source)
        const replyErr = `Adapter "${parentMsg.source}" is not connected (status: ${status ?? 'not running'}). Cannot reply to ${parentMsg.source} message.`
        console.warn(`[Mesh] Reply routing: adapter "${parentMsg.source}" not connected (status: ${status ?? 'not found'})`)
        try { senderReg.workspace.insertLog('warn', 'mesh', 'adapter_send_failed', parentMsg.source, replyErr) } catch { /* non-fatal */ }
        return { success: false, error: replyErr }
      }
    }

    // Resolve reply-to URL for outbound POST (card.endpoints.inbox > reply_to > auto-derived)
    const replyToUrl = senderConfig.card?.endpoints?.inbox
      ?? senderConfig.reply_to
      ?? `http://${this.meshHost}:${this.meshPort}/${senderReg.handle}/mesh/inbox`

    // Allow/block list check (DID-based)
    const recipientLocal = this.resolveLocalAgent(recipient) ?? this.resolveLocalAgentByUrl(address)
    if (recipientLocal) {
      const recipientDid = recipientLocal.workspace.getDid()

      // Outbound: check sender's allow/block list
      const { allow_list: senderAllow, block_list: senderBlock } = senderConfig.messaging ?? {}
      if (!recipientDid && (senderAllow?.length || senderBlock?.length)) {
        return { success: false, error: 'Recipient DID not available; cannot evaluate sender\'s allow/block list' }
      }
      if (recipientDid && !isAllowedByList(recipientDid, senderAllow, senderBlock)) {
        return { success: false, error: `Recipient is blocked by sender's allow/block list` }
      }

      // Inbound: check recipient's allow/block list
      const { allow_list: recipAllow, block_list: recipBlock } = recipientLocal.config.messaging ?? {}
      if (!senderDid && (recipAllow?.length || recipBlock?.length)) {
        return { success: false, error: 'Sender DID not available; cannot evaluate recipient\'s allow/block list' }
      }
      if (senderDid && !isAllowedByList(senderDid, recipAllow, recipBlock)) {
        return { success: false, error: `Sender is blocked by recipient's allow/block list` }
      }
    }

    // Resolve attachments from sender's file store
    const resolvedAttachments: StoredAttachment[] = []
    if (attachments && attachments.length > 0) {
      const maxBytes = senderConfig.limits?.max_file_write_bytes ?? 5000000
      for (const fp of attachments) {
        const fileContent = senderReg.workspace.readFileBuffer(fp)
        if (!fileContent) {
          resolvedAttachments.push({ filename: basename(fp), content_type: 'application/octet-stream', transfer: 'inline', skipped: true, reason: 'File not found' })
          continue
        }
        if (fileContent.length > maxBytes) {
          resolvedAttachments.push({ filename: basename(fp), content_type: 'application/octet-stream', transfer: 'inline', size_bytes: fileContent.length, skipped: true, reason: `Exceeds max_file_write_bytes (${maxBytes} bytes)` })
          continue
        }
        resolvedAttachments.push({ path: fp, filename: basename(fp), content_type: this.getMimeType(basename(fp)), transfer: 'inline', size_bytes: fileContent.length })
      }
    }

    const timestamp = Date.now()

    // For mesh delivery, address is required
    if (!address) {
      return { success: false, error: 'Delivery address is required for mesh recipients' }
    }

    // Build ALF message (card is the URL to sender's card endpoint)
    const senderCardUrl = `http://${this.meshHost}:${this.meshPort}/${senderReg.handle}/mesh/card`
    let message = buildAlfMessage({
      from: senderDid,
      to: recipient,
      replyTo: replyToUrl,
      network,
      content,
      subject,
      threadId,
      parentId,
      senderAlias: senderHandle,
      cardUrl: senderCardUrl,
      meta: messageMeta,
      payloadMeta: meta,
      attachments: resolvedAttachments.filter(a => !a.skipped).map(a => ({
        filename: a.filename,
        content_type: a.content_type,
        transfer: a.transfer,
        size_bytes: a.size_bytes
      }))
    })

    // Create EgressContext for outbox middleware — default to HTTP
    const egressCtx: EgressContext = {
      message,
      transport: { address, method: 'http' },
      agent: { did: senderDid }
    }

    // Run outbox custom middleware (Tier 3) — operates on EgressContext
    const outboxMw = senderConfig.security?.middleware?.outbox
    if (outboxMw?.length && senderReg.codeSandboxService && senderReg.adfCallHandler) {
      const mwResult = await executeMiddlewareChain(
        outboxMw,
        { point: 'outbox', data: egressCtx, meta: {} },
        senderReg.workspace,
        senderReg.codeSandboxService,
        senderReg.adfCallHandler,
        senderConfig.id
      )
      if (mwResult.rejected) {
        return { success: false, error: `Outbox middleware rejected: ${mwResult.rejected.reason}` }
      }
      if (mwResult.data) {
        const ctx = mwResult.data as EgressContext
        message = ctx.message
        address = ctx.transport.address  // middleware can change delivery address
      }
    }

    // Resolve transport: local → WS → HTTP (runs after custom middleware)
    resolveTransport(egressCtx, fromFilePath, !!recipientLocal, this.wsConnectionManager)

    // Run egress pipeline (Tier 1 — signing, encryption based on security level)
    const pipelineCtx: AlfPipelineContext = {
      direction: 'egress',
      workspace: senderReg.workspace,
      localDid: senderDid,
      remoteDid: recipient,
      isLocal: !!recipientLocal,
      security: senderConfig.security ?? { allow_unsigned: true },
      derivedKey: this.derivedKeys.get(fromFilePath) ?? null
    }
    const pipelineResult = await this.pipeline.processEgress(message, pipelineCtx)
    if (pipelineResult.rejected) {
      return { success: false, error: `Egress pipeline rejected: ${pipelineResult.rejected.reason}` }
    }
    message = pipelineResult.data

    // Audit: capture full outbox message with inline attachment data before tombstoning
    try {
      const auditMsg = {
        ...message,
        payload: {
          ...message.payload,
          attachments: resolvedAttachments.filter(a => !a.skipped).map(a => {
            const buf = a.path ? senderReg.workspace.readFileBuffer(a.path) : null
            return buf
              ? { filename: a.filename, content_type: a.content_type, transfer: 'inline' as const, data: buf.toString('base64'), size_bytes: a.size_bytes }
              : { filename: a.filename, content_type: a.content_type, transfer: a.transfer, size_bytes: a.size_bytes }
          })
        }
      }
      senderReg.workspace.auditMessage('outbox', JSON.stringify(auditMsg), timestamp)
    } catch { /* audit is best-effort */ }

    // Write to sender's outbox (with new fields)
    const outboxId = senderReg.workspace.addToOutbox({
      from: senderDid,
      to: recipient,
      address,
      reply_to: replyToUrl,
      network,
      thread_id: threadId,
      parent_id: parentId,
      subject,
      content,
      meta,
      attachments: resolvedAttachments.length > 0 ? resolvedAttachments : undefined,
      message_id: message.id,
      owner: message.meta?.owner as string | undefined,
      card: message.meta?.card as string | undefined,
      return_path: replyToUrl,
      created_at: timestamp,
      status: 'pending',
      sender_alias: senderHandle,
      original_message: tombstoneMessage(message)
    })

    // Attempt local delivery
    if (egressCtx.transport.method === 'local' && recipientLocal) {
      // Enforce recipient's messaging.visibility tier on in-process delivery.
      // Uses the same reason strings as the HTTP preHandler (mesh-server enforceVisibility)
      // but returns a tool-level error envelope rather than an HTTP 403.
      const recipientVisibility = recipientLocal.config.messaging?.visibility ?? 'localhost'
      const localScope = ancestorScope(fromFilePath, recipientLocal.filePath)
      if (!permits(recipientVisibility, localScope)) {
        senderReg.workspace.updateOutboxStatus(outboxId, 'failed')
        return { success: false, error: denialReason(recipientVisibility) }
      }

      try {
        // Run ingress pipeline — enforce recipient's security config on local delivery
        const ingressCtx: AlfPipelineContext = {
          direction: 'ingress',
          workspace: recipientLocal.workspace,
          localDid: recipient,
          remoteDid: senderDid,
          isLocal: true,
          security: recipientLocal.config.security ?? { allow_unsigned: true },
          derivedKey: this.derivedKeys.get(recipientLocal.filePath) ?? null
        }
        const ingressResult = await this.pipeline.processIngress(message, ingressCtx)
        if (ingressResult.rejected) {
          senderReg.workspace.updateOutboxStatus(outboxId, 'failed')
          return { success: false, error: `Recipient rejected: ${ingressResult.rejected.reason}` }
        }
        message = ingressResult.data

        // Run inbox custom middleware (after verification, before storage)
        const recipientConfig = recipientLocal.config
        const inboxMw = recipientConfig.security?.middleware?.inbox
        if (inboxMw?.length && recipientLocal.codeSandboxService && recipientLocal.adfCallHandler) {
          const mwResult = await executeMiddlewareChain(
            inboxMw,
            { point: 'inbox', data: message, meta: {} },
            recipientLocal.workspace,
            recipientLocal.codeSandboxService,
            recipientLocal.adfCallHandler,
            recipientConfig.id
          )
          if (mwResult.rejected) {
            senderReg.workspace.updateOutboxStatus(outboxId, 'failed')
            return { success: false, error: `Inbox middleware rejected: ${mwResult.rejected.reason}` }
          }
          if (mwResult.data) {
            message = mwResult.data as AlfMessage
          }
        }

        // Copy non-skipped attachments to recipient's imported/<sender>/ directory
        const importedAttachments: StoredAttachment[] = []
        const attachmentBuffers: Map<string, Buffer> = new Map()
        for (const att of resolvedAttachments) {
          if (att.skipped) { importedAttachments.push(att); continue }
          const fileContent = senderReg.workspace.readFileBuffer(att.path!)
          if (!fileContent) { importedAttachments.push({ ...att, path: undefined, skipped: true, reason: 'Read failed' }); continue }
          attachmentBuffers.set(att.filename, fileContent)
          const importDir = `imported/${senderHandle}`
          const destPath = this.resolveUniqueImportPath(recipientLocal.workspace, importDir, att.filename)
          recipientLocal.workspace.writeFileBuffer(destPath, fileContent, att.content_type)
          importedAttachments.push({ ...att, path: destPath, transfer: 'imported' })
        }

        // Audit: capture full message with inline attachment data before stripping
        try {
          const auditMsg = {
            ...message,
            payload: {
              ...message.payload,
              attachments: message.payload.attachments?.map(a => {
                const buf = attachmentBuffers.get(a.filename)
                return buf ? { ...a, data: buf.toString('base64') } : a
              })
            }
          }
          recipientLocal.workspace.auditMessage('inbox', JSON.stringify(auditMsg), timestamp)
        } catch { /* audit is best-effort */ }

        const inboxFlattened = flattenMessageToInbox(message, timestamp)
        // Override attachments with local import paths
        if (importedAttachments.length > 0) {
          inboxFlattened.attachments = importedAttachments
        }
        const inboxId = recipientLocal.workspace.addToInbox(inboxFlattened)

        // Update outbox: delivered (local, no status_code)
        senderReg.workspace.updateOutboxStatus(outboxId, 'delivered', Date.now())

        // Emit inbox_updated so renderer can refresh
        const unread = recipientLocal.workspace.getInbox('unread')
        const read = recipientLocal.workspace.getInbox('read')
        this.emit('inbox_updated', { filePath: recipientLocal.filePath, inbox: [...unread, ...read] })

        // Fire on_inbox trigger
        recipientLocal.triggerEvaluator?.onInbox(senderDid, content, {
          mentioned: true, source: 'mesh',
          messageId: inboxId,
          parentId,
          threadId
        })

        // Log to message bus
        const recipientHandle = recipientLocal.handle
        this.messageBus.logEntry({
          timestamp,
          messageId: outboxId,
          from: senderHandle,
          to: [recipientHandle],
          channel: '*',
          type: 'message',
          content,
          delivered: true,
          deliveredTo: [recipientHandle]
        })

        console.log(`[Mesh] Local delivery: ${senderHandle} -> ${recipientHandle}`)
        return { success: true, messageId: inboxId }
      } catch (error) {
        console.error(`[Mesh] Local delivery failed:`, error)
        senderReg.workspace.updateOutboxStatus(outboxId, 'failed')
        try { senderReg.workspace.insertLog('error', 'egress', 'delivery_failed', recipient, `Local delivery failed: ${String(error).slice(0, 200)}`) } catch { /* non-fatal */ }
        return { success: false, error: `Local delivery failed: ${error}` }
      }
    }

    // WebSocket delivery
    if (egressCtx.transport.method === 'ws' && egressCtx.transport.connection_id && this.wsConnectionManager) {
      try {
        const result = await this.wsConnectionManager.send(egressCtx.transport.connection_id, JSON.stringify(message))
        if (result.success) {
          senderReg.workspace.updateOutboxDeliveryFull(outboxId, 'delivered', undefined, Date.now())
          console.log(`[Mesh] WS delivery to ${recipient} via ${egressCtx.transport.connection_id}`)
          return { success: true, messageId: outboxId }
        }
      } catch { /* fall through to HTTP */ }
      // WS delivery failed — fall through to HTTP
      console.warn(`[Mesh] WS delivery failed, falling back to HTTP`)
      egressCtx.transport.method = 'http'
    }

    // HTTP delivery for remote agents — POST full ALF message
    try {
      const response = await fetch(address, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      })

      const statusCode = response.status
      const deliveredAt = Date.now()

      if (statusCode >= 200 && statusCode < 300) {
        senderReg.workspace.updateOutboxDeliveryFull(outboxId, 'delivered', statusCode, deliveredAt)
        let messageId: string | undefined
        try {
          const body = await response.json() as { message_id?: string }
          messageId = body.message_id
        } catch { /* ignore parse errors */ }
        console.log(`[Mesh] HTTP delivery to ${address}: ${statusCode}`)
        return { success: true, messageId, statusCode }
      } else {
        senderReg.workspace.updateOutboxDeliveryFull(outboxId, 'failed', statusCode, deliveredAt)
        console.warn(`[Mesh] HTTP delivery to ${address} failed: ${statusCode}`)
        try { senderReg.workspace.insertLog('warn', 'egress', 'delivery_failed', recipient, `HTTP ${statusCode} from ${address}`) } catch { /* non-fatal */ }
        return { success: false, statusCode, error: `HTTP ${statusCode}` }
      }
    } catch (error) {
      senderReg.workspace.updateOutboxStatus(outboxId, 'failed')
      console.error(`[Mesh] HTTP delivery error:`, error)
      try { senderReg.workspace.insertLog('error', 'egress', 'delivery_failed', recipient, `HTTP delivery failed: ${String(error).slice(0, 200)}`) } catch { /* non-fatal */ }
      return { success: false, error: `HTTP delivery failed: ${error}` }
    }
  }

  /**
   * Resolve message recipients based on to/channel/directory filters
   */
  private async resolveRecipients(
    fromFilePath: string,
    to: string[],
    channels: string[],
    includeSubdirectories: boolean
  ): Promise<RegisteredAgent[]> {
    const recipients: RegisteredAgent[] = []
    const fromReg = this.registeredAgents.get(fromFilePath)
    if (!fromReg) return recipients

    // If specific recipients named, resolve them
    if (to.length > 0) {
      for (const name of to) {
        const resolvedPath = this.resolveFilePath(name, fromFilePath)
        if (resolvedPath) {
          const reg = this.registeredAgents.get(resolvedPath)
          if (reg && reg !== fromReg) {
            recipients.push(reg)
          }
        }
      }
      return recipients
    }

    // Broadcast: deliver to all agents in same tracked directory
    const fromDir = dirname(fromFilePath)

    for (const [filePath, reg] of this.registeredAgents) {
      if (filePath === fromFilePath) continue
      if (reg.trackedDirRoot !== fromReg.trackedDirRoot) continue

      if (!includeSubdirectories) {
        const regDir = dirname(filePath)
        if (regDir !== fromDir) continue
      }

      recipients.push(reg)
    }

    return recipients
  }

  /**
   * Get statuses of all registered agents for the UI.
   */
  getAgentStatuses(): MeshAgentStatus[] {
    const statuses: MeshAgentStatus[] = []

    for (const [filePath, reg] of this.registeredAgents) {
      statuses.push({
        filePath,
        handle: reg.handle,
        did: reg.workspace.getDid() ?? undefined,
        icon: reg.config.icon,
        state: 'idle' as AgentState,
        status: reg.workspace.getMeta('status') ?? undefined,
        participating: true,
        canReceive: reg.config.messaging?.receive ?? false,
        sendMode: reg.config.messaging?.mode,
        visibility: reg.config.messaging?.visibility ?? 'localhost',
        apiRouteCount: reg.config.serving?.api?.length ?? 0,
        publicEnabled: reg.config.serving?.public?.enabled ?? false,
        sharedCount: reg.config.serving?.shared?.patterns?.length ?? 0
      })
    }

    return statuses
  }

  /**
   * Get agent directory for the list_agents tool.
   * Returns full agent cards (AlfAgentCard) decorated with in_subdirectory and source.
   */
  getAgentDirectory(excludeFilePath?: string): (AlfAgentCard & { in_subdirectory: boolean; source: 'local-runtime' })[] {
    const directory: (AlfAgentCard & { in_subdirectory: boolean; source: 'local-runtime' })[] = []
    const excludeDir = excludeFilePath ? dirname(excludeFilePath) : null

    // Include all agents on the runtime (excluding the caller)
    for (const [filePath, reg] of this.registeredAgents) {
      if (filePath !== excludeFilePath) {
        const agentDir = dirname(filePath)
        const inSubdirectory = excludeDir ? agentDir !== excludeDir && agentDir.startsWith(excludeDir + sep) : false

        const servable: ServableAgent = {
          handle: reg.handle,
          filePath: reg.filePath,
          config: reg.config,
          workspace: reg.workspace,
          triggerEvaluator: reg.triggerEvaluator,
          adfCallHandler: reg.adfCallHandler,
          codeSandboxService: reg.codeSandboxService,
          getSigningKey: () => reg.workspace.getSigningKeys(this.derivedKeys.get(filePath) ?? null)?.privateKey ?? null
        }

        // Same-runtime caller: serve loopback URLs. The directory HTTP endpoint
        // provides observer-aware hosts for remote callers (see getDirectoryForScope).
        const card = buildAgentCard(servable, '127.0.0.1', this.meshPort)
        directory.push({ ...card, in_subdirectory: inSubdirectory, source: 'local-runtime' })
      }
    }

    return directory
  }

  /**
   * Return agent cards visible to a caller at `callerFilePath`, enforcing
   * the caller's own visibility tier and each target's visibility tier.
   *
   * Rules:
   *   - caller off                → [] (disabled agent sees nothing)
   *   - caller directory-tier     → only ancestor-directory agents that permit 'directory' scope
   *   - caller localhost/lan-tier → any same-runtime agent that permits the ancestor scope
   *
   * Each entry is decorated with `visibility`, `in_subdirectory`, `source`, and `runtime_did`.
   */
  getDirectoryForAgent(callerFilePath: string): AgentDiscoverEntry[] {
    const caller = this.registeredAgents.get(callerFilePath)
    if (!caller) return []
    const callerVisibility = caller.config.messaging?.visibility ?? 'localhost'
    if (callerVisibility === 'off') return []

    const callerDir = dirname(callerFilePath)
    const out: AgentDiscoverEntry[] = []

    for (const [fp, reg] of this.registeredAgents) {
      if (fp === callerFilePath) continue
      const targetVisibility = reg.config.messaging?.visibility ?? 'localhost'
      if (targetVisibility === 'off') continue

      const scope = ancestorScope(callerFilePath, reg.filePath)

      // A directory-tier caller can only discover via directory scope.
      if (callerVisibility === 'directory' && scope !== 'directory') continue

      if (!permits(targetVisibility, scope)) continue

      const servable: ServableAgent = {
        handle: reg.handle,
        filePath: reg.filePath,
        config: reg.config,
        workspace: reg.workspace,
        triggerEvaluator: reg.triggerEvaluator,
        adfCallHandler: reg.adfCallHandler,
        codeSandboxService: reg.codeSandboxService,
        getSigningKey: () => reg.workspace.getSigningKeys(this.derivedKeys.get(reg.filePath) ?? null)?.privateKey ?? null
      }
      // Same-runtime caller (the agent's own LLM asking agent_discover): serve loopback URLs.
      const card = buildAgentCard(servable, '127.0.0.1', this.meshPort)

      const agentDir = dirname(reg.filePath)
      const inSubdirectory = agentDir !== callerDir && agentDir.startsWith(callerDir + sep)

      out.push({
        ...card,
        visibility: targetVisibility,
        in_subdirectory: inSubdirectory,
        source: 'local-runtime',
        runtime_did: undefined // reserved: populated once the runtime has a stable DID
      })
    }
    return out
  }

  /**
   * Return agent cards filtered by the requester's network scope.
   *
   * Used by the HTTP GET /mesh/directory endpoint. Only includes agents whose
   * messaging.visibility permits the given scope; directory-tier agents are
   * never included here (they surface only through same-runtime agent_discover
   * calls, which have the ancestor-path context this HTTP endpoint lacks).
   *
   * `servingHost` is the interface the request arrived on (`request.socket.localAddress`);
   * it drives endpoint URL construction so LAN peers get LAN URLs, loopback peers get
   * loopback URLs. Falls back to loopback when missing (Unix socket, test call, etc.).
   */
  getDirectoryForScope(
    scope: 'localhost' | 'lan' | 'public',
    servingHost?: string | null
  ): (AlfAgentCard & { visibility: string; source: 'local-runtime' })[] {
    const host = servingHost ?? '127.0.0.1'
    const out: (AlfAgentCard & { visibility: string; source: 'local-runtime' })[] = []
    for (const [, reg] of this.registeredAgents) {
      const visibility = reg.config.messaging?.visibility ?? 'localhost'
      if (!permits(visibility, scope)) continue

      const servable: ServableAgent = {
        handle: reg.handle,
        filePath: reg.filePath,
        config: reg.config,
        workspace: reg.workspace,
        triggerEvaluator: reg.triggerEvaluator,
        adfCallHandler: reg.adfCallHandler,
        codeSandboxService: reg.codeSandboxService,
        getSigningKey: () => reg.workspace.getSigningKeys(this.derivedKeys.get(reg.filePath) ?? null)?.privateKey ?? null
      }
      const card = buildAgentCard(servable, host, this.meshPort)
      out.push({ ...card, visibility, source: 'local-runtime' })
    }
    return out
  }

  /**
   * True iff at least one registered agent has the given visibility tier.
   * Used at server start time to derive the network binding posture.
   */
  hasAgentOfTier(tier: 'directory' | 'localhost' | 'lan' | 'off'): boolean {
    for (const [, reg] of this.registeredAgents) {
      const v = reg.config.messaging?.visibility ?? 'localhost'
      if (v === tier) return true
    }
    return false
  }

  /**
   * True iff at least one registered agent is reachable (visibility !== 'off').
   * When false, there's no reason to bind the mesh server at all.
   */
  hasAnyReachableAgent(): boolean {
    for (const [, reg] of this.registeredAgents) {
      const v = reg.config.messaging?.visibility ?? 'localhost'
      if (v !== 'off') return true
    }
    return false
  }

  /**
   * Inject the mDNS service (created by the IPC layer after mesh server starts).
   * Stored here so `agent_discover(scope: 'all')` can consult the discovered peers.
   */
  setMdnsService(service: MdnsService | null): void {
    this.mdnsService = service
  }

  /** Inject the shared directory fetch cache used for remote `/mesh/directory` fetches. */
  setDirectoryFetchCache(cache: DirectoryFetchCache | null): void {
    this.directoryFetchCache = cache
  }

  /** Surface an mDNS discovery as a MeshEvent so the renderer can update live. */
  emitRuntimeDiscovered(peer: DiscoveredRuntime): void {
    this.emitMeshEvent({
      type: 'lan_peer_discovered',
      payload: {
        runtime_id: peer.runtime_id,
        runtime_did: peer.runtime_did,
        host: peer.host,
        port: peer.port,
        url: peer.url,
        directory_path: peer.directory_path
      },
      timestamp: Date.now()
    })
  }

  emitRuntimeExpired(peer: DiscoveredRuntime): void {
    this.emitMeshEvent({
      type: 'lan_peer_expired',
      payload: {
        runtime_id: peer.runtime_id,
        runtime_did: peer.runtime_did,
        host: peer.host,
        port: peer.port,
        url: peer.url,
        directory_path: peer.directory_path
      },
      timestamp: Date.now()
    })
  }

  /**
   * Fetch cards from every mDNS-discovered remote runtime in parallel, merge
   * and tag them with `source: 'mdns'` + `runtime_did`. Unreachable peers drop
   * silently — the returned list reflects only runtimes that responded within
   * the cache's timeout.
   *
   * Caller-visibility semantics match `getDirectoryForAgent`: an off-tier
   * caller sees nothing. Remote runtimes apply their own tier filtering per
   * our request's network scope at `/mesh/directory` time.
   */
  async getRemoteDirectoryForAgent(callerFilePath: string): Promise<AgentDiscoverEntry[]> {
    if (!this.mdnsService || !this.directoryFetchCache) return []
    const caller = this.registeredAgents.get(callerFilePath)
    if (!caller) return []
    const callerVisibility = caller.config.messaging?.visibility ?? 'localhost'
    if (callerVisibility === 'off') return []

    const peers = this.mdnsService.getDiscoveredRuntimes()
    if (peers.length === 0) return []

    const fetches = peers.map(async (peer) => {
      const cards = await this.directoryFetchCache!.fetch(peer.url)
      return cards.map((card) => ({
        ...card,
        source: 'mdns' as const,
        runtime_did: peer.runtime_did,
        in_subdirectory: false
      }))
    })

    const results = await Promise.all(fetches)
    return results.flat()
  }

  /**
   * Get a servable agent by handle for HTTP serving.
   */
  getServableAgent(handle: string): ServableAgent | null {
    const filePath = this.handleToFilePath.get(handle)
    if (!filePath) return null
    const reg = this.registeredAgents.get(filePath)
    if (!reg) return null
    return {
      handle: reg.handle,
      filePath: reg.filePath,
      config: reg.config,
      workspace: reg.workspace,
      triggerEvaluator: reg.triggerEvaluator,
      adfCallHandler: reg.adfCallHandler,
      codeSandboxService: reg.codeSandboxService,
      getSigningKey: () => reg.workspace.getSigningKeys(this.derivedKeys.get(filePath) ?? null)?.privateKey ?? null
    }
  }

  /**
   * Get all servable agents for the HTTP directory listing.
   */
  getServableAgents(): ServableAgent[] {
    const agents: ServableAgent[] = []
    for (const [filePath, reg] of this.registeredAgents.entries()) {
      agents.push({
        handle: reg.handle,
        filePath: reg.filePath,
        config: reg.config,
        workspace: reg.workspace,
        triggerEvaluator: reg.triggerEvaluator,
        adfCallHandler: reg.adfCallHandler,
        codeSandboxService: reg.codeSandboxService,
        getSigningKey: () => reg.workspace.getSigningKeys(this.derivedKeys.get(filePath) ?? null)?.privateKey ?? null
      })
    }
    return agents
  }

  /**
   * Get debug info about the mesh state.
   */
  getDebugInfo(): {
    running: boolean
    busRegistrations: { name: string; channels: string[] }[]
    backgroundAgents: { filePath: string; name: string; state: AgentState; onMessageReceived: boolean; hasMessaging: boolean; toolCount: number }[]
    foregroundAgents: { filePath: string; name: string; onMessageReceived: boolean; hasMessaging: boolean }[]
    messageLog: MessageBusLogEntry[]
  } {
    let busRegistrations: { name: string; channels: string[] }[] = []
    let backgroundAgents: { filePath: string; name: string; state: AgentState; onMessageReceived: boolean; hasMessaging: boolean; toolCount: number }[] = []
    let foregroundAgents: { filePath: string; name: string; onMessageReceived: boolean; hasMessaging: boolean }[] = []
    let messageLog: MessageBusLogEntry[] = []

    try {
      busRegistrations = this.messageBus.getRegistrations()
    } catch (err) {
      console.error('[Mesh] getDebugInfo: busRegistrations error:', err)
    }

    try {
      backgroundAgents = Array.from(this.registeredAgents.values())
        .filter((r) => !r.isForeground)
        .map((r) => ({
          filePath: r.filePath,
          name: basename(r.filePath, '.adf'),
          state: 'idle' as AgentState,
          onMessageReceived: r.config.messaging?.receive ?? false,
          hasMessaging: !!r.config.messaging,
          toolCount: r.toolRegistry.getAll().length
        }))
    } catch (err) {
      console.error('[Mesh] getDebugInfo: backgroundAgents error:', err)
    }

    try {
      foregroundAgents = Array.from(this.registeredAgents.values())
        .filter((r) => r.isForeground)
        .map((r) => ({
          filePath: r.filePath,
          name: basename(r.filePath, '.adf'),
          onMessageReceived: r.config.messaging?.receive ?? false,
          hasMessaging: !!r.config.messaging
        }))
    } catch (err) {
      console.error('[Mesh] getDebugInfo: foregroundAgents error:', err)
    }

    try {
      messageLog = this.messageBus.getLog()
    } catch (err) {
      console.error('[Mesh] getDebugInfo: messageLog error:', err)
    }

    return { running: this.enabled, busRegistrations, backgroundAgents, foregroundAgents, messageLog }
  }

  /**
   * Reset a registered agent's session (called when user clears chat for a background agent).
   */
  resetAgentSession(filePath: string): void {
    const reg = this.registeredAgents.get(filePath)
    if (!reg) return
    reg.session.reset()
    reg.workspace.writeChat({ version: 1, uiLog: [], llmMessages: [] })
  }

  /**
   * Get recent tool calls for all registered agents from their loop tables.
   * Returns a map of filePath → recent tool activities.
   */
  getRecentTools(limit = 5): Record<string, { name: string; args?: string; isError?: boolean; timestamp: number }[]> {
    const result: Record<string, { name: string; args?: string; isError?: boolean; timestamp: number }[]> = {}

    for (const [filePath, reg] of this.registeredAgents) {
      try {
        const totalCount = reg.workspace.getLoopCount()
        // Read the last ~30 entries to find enough tool calls
        const offset = Math.max(0, totalCount - 30)
        const entries = offset > 0
          ? reg.workspace.getLoopPaginated(30, offset)
          : reg.workspace.getLoop()

        // Track tool_use_id → { name, args, timestamp } for matching with results
        const toolUseMap = new Map<string, { name: string; args?: string; timestamp: number }>()
        const tools: { name: string; args?: string; isError?: boolean; timestamp: number }[] = []

        for (const entry of entries) {
          for (const block of entry.content_json) {
            if (block.type === 'tool_use' && block.name && block.id) {
              let args: string | undefined
              if (block.input) {
                try {
                  const input = block.input as Record<string, unknown>
                  if (typeof input._reason === 'string' && input._reason) {
                    args = input._reason
                  } else {
                    const str = typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
                    args = str.length > 40 ? str.slice(0, 40) + '...' : str
                  }
                } catch { /* ignore */ }
              }
              toolUseMap.set(block.id, { name: block.name, args, timestamp: entry.created_at })
            } else if (block.type === 'tool_result' && block.tool_use_id) {
              const matched = toolUseMap.get(block.tool_use_id)
              if (matched) {
                tools.push({ ...matched, isError: !!block.is_error })
                toolUseMap.delete(block.tool_use_id)
              }
            }
          }
        }

        // Any unmatched tool_use (still in progress) — add without result
        for (const pending of toolUseMap.values()) {
          tools.push(pending)
        }

        result[filePath] = tools.slice(-limit)
      } catch (err) {
        console.error(`[Mesh] getRecentTools error for ${filePath}:`, err)
        result[filePath] = []
      }
    }

    return result
  }

  // --- Adapter delivery helper ---

  private async sendViaAdapter(
    senderReg: RegisteredAgent,
    adapterManager: ChannelAdapterManager,
    adapterType: string,
    recipientId: string,
    recipientLabel: string,
    content: string,
    subject?: string,
    threadId?: string,
    parentId?: string,
    attachments?: string[],
    messageMeta?: Record<string, unknown>
  ): Promise<{ success: boolean; messageId?: string; statusCode?: number; error?: string }> {
    const senderConfig = senderReg.config
    // Identity is opt-in: fall back to handle when the agent has no DID.
    // Use `||` not `??` — getDid() can return an empty string.
    const senderDid = senderReg.workspace.getDid() || senderReg.handle
    const timestamp = Date.now()

    // Resolve attachments for adapter delivery
    const adapterAttachments: import('../../shared/types/channel-adapter.types').Attachment[] = []
    if (attachments && attachments.length > 0) {
      const maxBytes = senderConfig.limits?.max_file_write_bytes ?? 5000000
      for (const fp of attachments) {
        const fileContent = senderReg.workspace.readFileBuffer(fp)
        if (!fileContent) continue
        if (fileContent.length > maxBytes) continue
        adapterAttachments.push({
          path: fp,
          filename: basename(fp),
          mimeType: this.getMimeType(basename(fp)),
          size: fileContent.length,
          data: fileContent
        })
      }
    }

    // Write outbox row
    const outboxId = senderReg.workspace.addToOutbox({
      from: senderDid,
      to: recipientLabel,
      thread_id: threadId,
      parent_id: parentId,
      subject,
      content,
      created_at: timestamp,
      status: 'pending'
    })

    // Build outbound message
    const outbound: OutboundMessage = {
      id: nanoid(),
      recipientId,
      recipientName: recipientLabel,
      traceId: threadId,
      parentId,
      subject,
      payload: content,
      attachments: adapterAttachments.length > 0 ? adapterAttachments : undefined
    }

    // Copy source_context from parent inbox message for reply threading.
    // Without parent_id, the message is sent as a private/direct message
    // using recipientId as the chat_id. The agent can inspect source_context.chat_type
    // on inbox messages to decide whether to reply in-context (via parent_id) or DM.
    if (parentId) {
      const inboxMessages = senderReg.workspace.getInbox()
      const parentMsg = inboxMessages.find(m => m.id === parentId)
      if (parentMsg?.source_context) {
        outbound.sourceMeta = parentMsg.source_context as Record<string, unknown>
      }
    }

    // Pass agent's message_meta as routing hints (kept separate from sourceMeta
    // to avoid collisions with inbound source_context fields like to/cc).
    if (messageMeta) {
      outbound.routingHints = messageMeta
    }

    const result = await adapterManager.send(adapterType, outbound)
    if (result.success) {
      if (result.sourceMeta) {
        const meta = result.sourceMeta as Record<string, unknown>
        senderReg.workspace.updateOutboxMeta(outboxId, meta)
        if (meta.message_id != null) {
          adapterManager.registerDelivery(adapterType, meta.message_id as number | string, outboxId)
        }
      }
      senderReg.workspace.updateOutboxStatus(outboxId, 'delivered', Date.now())
      console.log(`[Mesh] Adapter delivery to ${recipientLabel}: success`)
      return { success: true, messageId: outboxId }
    } else {
      senderReg.workspace.updateOutboxStatus(outboxId, 'failed')
      console.warn(`[Mesh] Adapter delivery to ${recipientLabel} failed: ${result.error}`)
      return { success: false, error: result.error ?? 'Adapter delivery failed' }
    }
  }

  // --- DID/address resolution helpers ---

  /**
   * Resolve a DID to a locally registered agent.
   */
  private resolveLocalAgent(did: string): RegisteredAgent | null {
    for (const reg of this.registeredAgents.values()) {
      if (reg.workspace.getDid() === did) return reg
    }
    return null
  }

  /**
   * Resolve a delivery URL to a locally registered agent.
   * If the URL points to localhost on the mesh port, extract handle from path.
   */
  private resolveLocalAgentByUrl(address?: string): RegisteredAgent | null {
    if (!address) return null
    try {
      const url = new URL(address)
      const host = url.hostname
      const port = parseInt(url.port, 10)
      if ((host === '127.0.0.1' || host === 'localhost' || host === '::1') && port === this.meshPort) {
        // Extract handle from path: /{handle}/mesh/inbox
        const parts = url.pathname.split('/').filter(Boolean)
        if (parts.length >= 1) {
          const identifier = decodeURIComponent(parts[0])
          const filePath = this.handleToFilePath.get(identifier)
          if (filePath) return this.registeredAgents.get(filePath) ?? null
          // Try DID match
          return this.resolveLocalAgent(identifier)
        }
      }
    } catch { /* not a valid URL */ }
    return null
  }

  // --- Private helpers ---

  private registerCommunicationTools(
    filePath: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
    isMessageTriggeredFn?: () => boolean
  ): void {
    if (!toolRegistry.get('msg_send')) {
      const sendMessageTool = new SendMessageTool(
        async (recipient, address, content, subject, threadId, parentId, attachments, meta, messageMeta) =>
          this.sendMessage(filePath, recipient, address, content, subject, threadId, parentId, attachments, meta, messageMeta),
        () => ({
          sendMode: config.messaging?.mode ?? 'respond_only',
          isMessageTriggered: isMessageTriggeredFn ? isMessageTriggeredFn() : false
        }),
        // Resolve bare handles against locally-registered agents (exclude the caller).
        // Also enforce the recipient's messaging.visibility tier — a directory-tier
        // agent outside the caller's ancestor chain returns a denial with the same
        // reason string the HTTP 403 would produce.
        (handle) => {
          for (const [fp, reg] of this.registeredAgents) {
            if (fp === filePath) continue
            if (reg.handle !== handle) continue
            const did = reg.workspace.getDid() || undefined
            const address = `http://${this.meshHost}:${this.meshPort}/${reg.handle}/mesh/inbox`
            const visibility = reg.config.messaging?.visibility ?? 'localhost'
            const scope = ancestorScope(filePath, reg.filePath)
            if (!permits(visibility, scope)) {
              return { ok: false as const, reason: denialReason(visibility) }
            }
            return { ok: true as const, address, did }
          }
          return null
        }
      )
      toolRegistry.register(sendMessageTool)
    }
    if (!toolRegistry.get('agent_discover')) {
      const discoverTool = new AgentDiscoverTool(
        () => this.getDirectoryForAgent(filePath),
        () => this.getRemoteDirectoryForAgent(filePath)
      )
      toolRegistry.register(discoverTool)
    }

    if (!toolRegistry.get('msg_list')) {
      toolRegistry.register(new InboxCheckTool())
    }
    if (!toolRegistry.get('msg_read')) {
      toolRegistry.register(new InboxReadTool())
    }
    if (!toolRegistry.get('msg_update')) {
      toolRegistry.register(new InboxUpdateTool())
    }

    if (this.wsConnectionManager) {
      const wsm = this.wsConnectionManager
      const fp = filePath
      if (!toolRegistry.get('ws_connect')) {
        toolRegistry.register(new WsConnectTool(
          (opts) => wsm.connectOutbound(fp, opts.id ? opts.id : {
            id: opts.id ?? nanoid(),
            url: opts.url!,
            did: opts.did,
            enabled: true,
            lambda: opts.lambda,
            auto_reconnect: opts.auto_reconnect,
            reconnect_delay_ms: opts.reconnect_delay_ms,
            keepalive_interval_ms: opts.keepalive_interval_ms
          })
        ))
      }
      if (!toolRegistry.get('ws_disconnect')) {
        toolRegistry.register(new WsDisconnectTool(
          async (connId, _configId) => {
            if (connId) { wsm.disconnect(connId); return { success: true } }
            return { success: false, error: 'connection_id required' }
          }
        ))
      }
      if (!toolRegistry.get('ws_connections')) {
        toolRegistry.register(new WsConnectionsTool(
          (filter) => wsm.getConnections(fp, filter)
        ))
      }
      if (!toolRegistry.get('ws_send')) {
        toolRegistry.register(new WsSendTool(
          async (connId, data) => wsm.send(connId, data)
        ))
      }
    }
  }

  private ensureCommunicationTools(config: AgentConfig): void {
    const toolNames = config.tools.map((t) => t.name)
    if (!toolNames.includes('msg_send')) {
      config.tools.push({ name: 'msg_send', enabled: true, visible: true })
    }
    if (!toolNames.includes('agent_discover')) {
      config.tools.push({ name: 'agent_discover', enabled: true, visible: true })
    }
    for (const toolName of ['msg_list', 'msg_read', 'msg_update']) {
      if (!toolNames.includes(toolName)) {
        config.tools.push({ name: toolName, enabled: true, visible: true })
      }
    }
    // WS tools — auto-enable when agent has WS routes or outbound WS connections
    // but respect explicit user disabling (only force-enable if tool was missing, not if user toggled it off)
    const hasWs = config.serving?.api?.some(r => r.method === 'WS') || (config.ws_connections?.length ?? 0) > 0
    for (const toolName of ['ws_connect', 'ws_disconnect', 'ws_connections', 'ws_send']) {
      const existing = config.tools.find(t => t.name === toolName)
      if (!existing) {
        config.tools.push({ name: toolName, enabled: hasWs, visible: hasWs })
      }
    }
  }


  /**
   * Resolve an absolute file path to the agent's handle.
   */
  private resolveAgentHandle(filePath: string): string {
    const reg = this.registeredAgents.get(filePath)
    if (!reg) return deriveHandle(filePath)
    return reg.handle
  }

  /**
   * Resolve a relative agent name to an absolute file path.
   * Searches within the same tracked directory as the requesting agent.
   */
  private resolveFilePath(agentName: string, requestingFilePath: string): string | null {
    const requestingReg = this.registeredAgents.get(requestingFilePath)
    if (!requestingReg) return null

    const trackedDirRoot = requestingReg.trackedDirRoot
    const candidatePath = this.resolveAgentPath(trackedDirRoot, agentName)

    // Check if this resolved path is actually registered
    if (this.registeredAgents.has(candidatePath)) {
      return candidatePath
    }

    return null
  }

  private logOutgoingMessage(
    fromFilePath: string,
    recipient: string,
    content: string,
    replyTo?: string
  ): void {
    const senderHandle = this.resolveAgentHandle(fromFilePath)

    const logEntry = {
      id: nanoid(),
      type: 'inter_agent' as const,
      content,
      timestamp: Date.now(),
      metadata: {
        fromAgent: senderHandle,
        toAgent: recipient,
        direction: 'outgoing' as const
      }
    }

    const reg = this.registeredAgents.get(fromFilePath)
    if (reg) {
      const existing = reg.workspace.readChat()
      const uiLog = existing?.uiLog ?? []
      uiLog.push(logEntry)
      reg.workspace.writeChat({
        version: 1,
        uiLog,
        llmMessages: existing?.llmMessages ?? []
      })

      // Inbox mode: write outgoing message to inbox + auto-handle replied-to message
      if (reg.config.messaging?.inbox_mode) {
        const senderDid = reg.workspace.getDid() || reg.handle
        reg.workspace.addToInbox({
          from: senderDid,
          to: recipient,
          source: 'mesh',
          content,
          received_at: logEntry.timestamp,
          status: 'read'  // outgoing messages are pre-read
        })

        // Emit inbox_updated so renderer can refresh
        const unread = reg.workspace.getInbox('unread')
        const read = reg.workspace.getInbox('read')
        this.emit('inbox_updated', { filePath: fromFilePath, inbox: [...unread, ...read] })

        // Auto-mark the replied-to message as handled
        if (replyTo) {
          this.autoHandleInboxMessage(reg.workspace, replyTo, fromFilePath)
        }
      }
    }
  }

  private autoHandleInboxMessage(workspace: AdfWorkspace, replyToId: string, filePath?: string): void {
    const messages = workspace.getInbox('unread')
    for (const msg of messages) {
      if (msg.id === replyToId) {
        workspace.updateInboxStatus(msg.id, 'read')
        if (filePath) {
          const unread = workspace.getInbox('unread')
          const read = workspace.getInbox('read')
          this.emit('inbox_updated', { filePath, inbox: [...unread, ...read] })
        }
        break
      }
    }
  }

  /**
   * Resolve a unique import path for an attachment, appending a counter on collision.
   */
  private resolveUniqueImportPath(workspace: AdfWorkspace, dir: string, filename: string): string {
    let candidate = `${dir}/${filename}`
    if (!workspace.fileExists(candidate)) return candidate

    const dot = filename.lastIndexOf('.')
    const base = dot > 0 ? filename.slice(0, dot) : filename
    const ext = dot > 0 ? filename.slice(dot) : ''
    let counter = 1
    while (workspace.fileExists(candidate)) {
      candidate = `${dir}/${base} (${counter})${ext}`
      counter++
    }
    return candidate
  }

  /**
   * Derive MIME type from filename extension.
   */
  private getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase()
    const types: Record<string, string> = {
      md: 'text/markdown', txt: 'text/plain', json: 'application/json',
      csv: 'text/csv', pdf: 'application/pdf', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', html: 'text/html', xml: 'application/xml',
      yaml: 'text/yaml', yml: 'text/yaml', ts: 'text/typescript',
      js: 'text/javascript', css: 'text/css',
      ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/opus'
    }
    return types[ext ?? ''] ?? 'application/octet-stream'
  }

  private emitMeshEvent(event: MeshEvent): void {
    this.emit('mesh_event', event)
  }
}
