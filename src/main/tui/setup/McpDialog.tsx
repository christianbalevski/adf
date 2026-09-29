// /mcp: the selected agent's MCP servers with their live state; add one
// (catalog, npm, Python, remote URL), see one (state, error, where it runs,
// tools with on/off, logs), restart, edit its credentials, remove. Credential
// values live in this component's state only and go to the agent's sealed
// identity store; never the store, overlay props, toasts or logs.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore, useTuiSelector } from '../state/store'
import { List } from '../ui/List'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { formatClock, truncate } from '../ui/text'
import { Form, type FieldSpec, type FormValues } from '../views/loops/Form'
import { LinesView } from '../views/inspect/LinesView'
import type { Line } from '../views/inspect/format'
import type { AgentConfig, AgentMcpDiagnostics, McpRestartResult, McpServerConfig } from '../api/types'
import type { OverlayProps } from '../views/types'
import { channelsIdentityReady, identityFirst } from './open'
import {
  MCP_OVERLAY,
  credentialNamespace,
  defaultServerName,
  envKeysOf,
  joinArgs,
  mcpSourceRows,
  packageToInstall,
  parseAddTarget,
  runsOnText,
  serverConfigFor,
  serverEnvKeys,
  serverToolDecls,
  studioOnlyReason,
  validateMcpForm,
  type McpOverlayProps,
  type McpSourceRow,
} from './mcp'

type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
interface WorkStep { label: string; status: StepStatus; note?: string }

type Step =
  | { kind: 'list' }
  | { kind: 'detail'; name: string }
  | { kind: 'logs'; name: string }
  | { kind: 'tools'; name: string }
  | { kind: 'remove'; name: string; busy?: boolean }
  | { kind: 'source' }
  | { kind: 'form'; row: McpSourceRow }
  | { kind: 'env'; name: string }
  | { kind: 'work'; name: string; steps: WorkStep[]; outcome?: McpRestartResult; done: boolean }

type McpState = AgentMcpDiagnostics['states'][number]

export function McpDialog({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const props = (overlay.props ?? {}) as McpOverlayProps
  const agentId = props.agentId ?? store.getState().selectedAgentId ?? ''
  const agent = useTuiSelector(s => s.agents[agentId])
  const who = agent?.summary.handle || agent?.summary.name || agentId
  const sources = useMemo(mcpSourceRows, [])
  const [diag, setDiag] = useState<AgentMcpDiagnostics | null>(null)
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const initial = (): Step => {
    if (props.add !== undefined) {
      const target = parseAddTarget(props.add)
      return target.row ? { kind: 'form', row: target.row } : { kind: 'source' }
    }
    if (props.server) return { kind: props.view === 'logs' ? 'logs' : 'detail', name: props.server }
    return { kind: 'list' }
  }
  const [step, setStep] = useState<Step>(initial)
  const [index, setIndex] = useState(0)
  const [values, setValues] = useState<FormValues>(() => {
    const target = parseAddTarget(props.add)
    return target.row ? initialForm(target.row, target.value) : {}
  })
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const direct = props.add !== undefined || !!props.server

  const refresh = async () => {
    try {
      const [d, c] = await Promise.all([store.client.agentMcp(agentId), store.client.config(agentId)])
      if (!alive.current) return
      setDiag(d); setConfig(c.config); setLoadError(null)
    } catch (err) {
      if (alive.current) setLoadError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => { if (agentId) void refresh() }, [agentId])

  const servers: McpServerConfig[] = config?.mcp?.servers ?? []
  const stateOf = (name: string): McpState | undefined => diag?.states.find(s => s.name === name)
  const serverOf = (name: string) => servers.find(s => s.name === name)
  const hostAllowed = !!(config?.compute as { host_access?: boolean } | undefined)?.host_access
  const dialogWidth = Math.max(56, Math.min(width - 4, 96))
  const inner = dialogWidth - 4
  const back = () => { if (direct) close(); else setStep({ kind: 'list' }) }
  // A catalog entry may preselect the host; without host access the container is the only choice.
  useEffect(() => {
    if (config && !hostAllowed && values.runOn === 'host') setValues(v => ({ ...v, runOn: 'container' }))
  }, [config, step.kind])

  // --- actions -------------------------------------------------------------------

  const restart = async (name: string) => {
    setStep({ kind: 'work', name, done: false, steps: [{ label: `Connecting ${name}`, status: 'running' }] })
    await runConnect(name, [])
  }

  /** Last step of add / env edit / restart: connect now and show the outcome. */
  const runConnect = async (name: string, earlier: WorkStep[]) => {
    const steps: WorkStep[] = [...earlier, { label: `Connecting ${name}`, status: 'running' }]
    setStep({ kind: 'work', name, done: false, steps })
    try {
      const outcome = await store.client.restartMcpServer(agentId, name)
      if (!alive.current) return
      const ok = outcome.toolsDiscovered > 0 && !outcome.error
      steps[steps.length - 1] = { label: `Connecting ${name}`, status: ok ? 'done' : 'failed', note: ok ? `${outcome.toolsDiscovered} tools · ${outcome.location ?? ''}` : outcome.error ?? 'no tools found' }
      setStep({ kind: 'work', name, done: true, steps: [...steps], outcome })
    } catch (err) {
      if (!alive.current) return
      const message = err instanceof Error ? err.message : String(err)
      steps[steps.length - 1] = { label: `Connecting ${name}`, status: /not running/i.test(message) ? 'skipped' : 'failed', note: message }
      setStep({ kind: 'work', name, done: true, steps: [...steps] })
    }
    await refresh()
  }

  const text = (key: string) => (typeof values[key] === 'string' ? values[key] as string : '')

  const add = async (row: McpSourceRow) => {
    const env: Record<string, string> = {}
    for (const { key } of envKeysOf(row)) if (text(`env:${key}`).trim()) env[key] = text(`env:${key}`).trim()
    for (const [key, value] of parseEnvPairs(text('extraEnv'))) env[key] = value
    const form = { name: text('name').trim(), source: text('source').trim(), args: text('args'), runOn: values.runOn === 'host' ? 'host' as const : 'container' as const, env }
    const problems = validateMcpForm(row, form, servers.map(s => s.name))
    if (text('extraEnv').trim() && parseEnvPairs(text('extraEnv')).length === 0) problems.extraEnv = 'KEY=value pairs, space-separated.'
    if (Object.keys(problems).length > 0) { setErrors(problems); return }
    if (Object.keys(env).length > 0 && !channelsIdentityReady(store)) {
      close()
      identityFirst(store, MCP_OVERLAY, { agentId, add: props.add ?? '' }, 'MCP credentials are sealed under your owner identity: set it up first, then add the server again.')
      return
    }
    setErrors({}); setFormError(null)
    // Extra env keys (custom sources) join the server's agent-scoped keys.
    const server = serverConfigFor(row, form)
    const extraKeys = Object.keys(env).filter(k => !(server.env_keys ?? []).includes(k))
    if (extraKeys.length) {
      server.env_keys = [...(server.env_keys ?? []), ...extraKeys]
      server.env_schema = [...(server.env_schema ?? []), ...extraKeys.map(key => ({ key, scope: 'agent' as const }))]
    }
    const pkg = packageToInstall(server)
    const steps: WorkStep[] = [
      ...(pkg ? [{ label: `Installing ${pkg.name} (${pkg.kind})`, status: 'pending' as const }] : []),
      ...(Object.keys(env).length ? [{ label: `Sealing ${Object.keys(env).length} credential${Object.keys(env).length === 1 ? '' : 's'} in ${who}`, status: 'pending' as const }] : []),
      { label: `Attaching ${form.name} to ${who}`, status: 'pending' },
    ]
    const show = () => { if (alive.current) setStep({ kind: 'work', name: form.name, done: false, steps: [...steps] }) }
    const fail = (i: number, err: unknown) => {
      steps[i] = { ...steps[i], status: 'failed', note: err instanceof Error ? err.message : String(err) }
      if (alive.current) setStep({ kind: 'work', name: form.name, done: true, steps: [...steps] })
    }
    setValues({})
    let i = 0
    if (pkg) {
      steps[i] = { ...steps[i], status: 'running' }; show()
      try {
        await store.client.installMcpPackage(pkg.kind, pkg.name)
        steps[i] = { ...steps[i], status: 'done' }
      } catch (err) { fail(i, err); return }
      i++
    }
    if (Object.keys(env).length) {
      steps[i] = { ...steps[i], status: 'running' }; show()
      try {
        const ns = credentialNamespace(server)
        for (const [key, value] of Object.entries(env)) await store.client.setMcpCredential(agentId, ns, key, value)
        steps[i] = { ...steps[i], status: 'done' }
      } catch (err) { fail(i, err); return }
      i++
    }
    steps[i] = { ...steps[i], status: 'running' }; show()
    try {
      await store.client.attachMcpServer(agentId, server)
      steps[i] = { ...steps[i], status: 'done', note: server.run_location === 'host' ? 'runs on the host' : server.transport === 'http' ? 'remote' : 'runs in a container' }
    } catch (err) { fail(i, err); return }
    void store.actions.loadConfig(agentId)
    await runConnect(form.name, steps)
  }

  const saveEnv = async (name: string) => {
    const server = serverOf(name)
    if (!server) return
    const typed = serverEnvKeys(server).map(key => [key, text(`env:${key}`).trim()] as const).filter(([, v]) => v)
    if (typed.length === 0) { setErrors({ form: 'Type at least one new value (empty keeps what is stored).' }); return }
    if (!channelsIdentityReady(store)) {
      close()
      identityFirst(store, MCP_OVERLAY, { agentId, server: name }, 'MCP credentials are sealed under your owner identity: set it up first.')
      return
    }
    setValues({})
    const steps: WorkStep[] = [{ label: `Sealing ${typed.length} credential${typed.length === 1 ? '' : 's'} in ${who}`, status: 'running' }]
    setStep({ kind: 'work', name, done: false, steps })
    try {
      const ns = credentialNamespace(server)
      for (const [key, value] of typed) await store.client.setMcpCredential(agentId, ns, key, value)
      steps[0] = { ...steps[0], status: 'done' }
    } catch (err) {
      steps[0] = { ...steps[0], status: 'failed', note: err instanceof Error ? err.message : String(err) }
      if (alive.current) setStep({ kind: 'work', name, done: true, steps: [...steps] })
      return
    }
    await runConnect(name, steps)
  }

  const remove = async (name: string) => {
    const server = serverOf(name)
    setStep({ kind: 'remove', name, busy: true })
    const result = await store.actions.run(`Remove ${name}`, c => c.detachMcpServer(agentId, name, server ? credentialNamespace(server) : undefined))
    if (!alive.current) return
    if (result) {
      store.actions.toast(`${name} removed from ${who}${result.deletedCredentials ? ` (${result.deletedCredentials} credential${result.deletedCredentials === 1 ? '' : 's'} deleted)` : ''}`, 'success')
      void store.actions.loadConfig(agentId)
      await refresh()
    }
    if (!alive.current) return
    if (props.server) close(); else setStep({ kind: 'list' })
  }

  const toggleTool = async (decl: string) => {
    const fresh = await store.actions.run('Tools', c => c.config(agentId))
    if (!fresh || !alive.current) return
    const tools = (fresh.config.tools ?? []).map(t => (t.name === decl ? { ...t, enabled: t.enabled === false } : t))
    const saved = await store.actions.run('Tools', c => c.putConfig(agentId, { ...fresh.config, tools }))
    if (!saved || !alive.current) return
    setConfig({ ...fresh.config, tools })
    void store.actions.loadConfig(agentId)
    const now = tools.find(t => t.name === decl)
    store.actions.toast(`${decl} ${now?.enabled === false ? 'off' : 'on'}`, 'success', 2000)
  }

  // --- keys ------------------------------------------------------------------------

  useKeys((input, key) => {
    const cancel = key.escape || (key.ctrl && input === 'c')
    switch (step.kind) {
      case 'list':
        if (cancel) { close(); return true }
        return false
      case 'source':
        if (cancel) { back(); return true }
        return false
      case 'detail': {
        if (key.ctrl && input === 'c') { close(); return true }
        if (key.escape) { back(); return true }
        if (input === 'r') { void restart(step.name); return true }
        if (input === 'd') { setStep({ kind: 'remove', name: step.name }); return true }
        if (input === 'e') { setValues({}); setErrors({}); setStep({ kind: 'env', name: step.name }); return true }
        if (input === 'l') { setStep({ kind: 'logs', name: step.name }); return true }
        if (input === 't') { setStep({ kind: 'tools', name: step.name }); return true }
        return true
      }
      case 'logs':
        if (cancel || key.return) { if (props.view === 'logs') close(); else setStep({ kind: 'detail', name: step.name }); return true }
        return false
      case 'tools':
        if (cancel) { setStep({ kind: 'detail', name: step.name }); return true }
        return false
      case 'remove':
        if (step.busy) return true
        if (input === 'y' || input === 'Y' || key.return) { void remove(step.name); return true }
        if (input === 'n' || input === 'N' || cancel) { setStep({ kind: 'detail', name: step.name }); return true }
        return true
      case 'work':
        if (!step.done) return true
        if (key.ctrl && input === 'c') { close(); return true }
        if (key.escape || key.return) { if (direct) close(); else setStep({ kind: 'list' }); return true }
        if (input === 'l') { setStep({ kind: 'logs', name: step.name }); return true }
        if (input === 'r') { void restart(step.name); return true }
        return true
      default:
        return false
    }
  }, { layer: 'overlay', active: step.kind !== 'form' && step.kind !== 'env' })

  // --- views -----------------------------------------------------------------------

  if (!agent) {
    return (
      <Modal title="MCP servers" width={dialogWidth} onClose={close} hints={[{ keys: 'esc', label: 'close' }]}>
        <Text wrap="wrap" color={theme.color.warn}>Select an agent first, or create one with /new. MCP servers belong to one agent.</Text>
      </Modal>
    )
  }

  const statusGlyph = (s: McpState | undefined) => (s?.status === 'connected' ? theme.glyph.dot : s?.status === 'error' ? theme.glyph.cross : theme.glyph.ring)
  const statusColor = (s: McpState | undefined) => (s?.status === 'connected' ? theme.color.success : s?.status === 'error' ? theme.color.error : s ? theme.color.warn : theme.color.dim)

  if (step.kind === 'list') {
    const rows = servers
    const selected = rows[Math.min(index, rows.length - 1)]
    return (
      <Modal title={`MCP servers ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={[{ keys: 'enter', label: 'details' }, { keys: 'a', label: 'add' }, { keys: 'r', label: 'restart' }, { keys: 'd', label: 'remove' }, { keys: 'esc', label: 'close' }]}>
        <Text color={theme.color.muted} wrap="truncate-end">Tools {who} gets from MCP servers. They run in a container unless you pick the host.</Text>
        {loadError ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {loadError}</Text> : null}
        {!config && !loadError ? <Spinner label="reading servers…" /> : (
          <List
            items={rows}
            getKey={s => s.name}
            height={Math.max(1, Math.min(rows.length || 1, height - 10))}
            width={inner}
            keyLayer="overlay"
            selectedIndex={Math.min(index, Math.max(0, rows.length - 1))}
            onSelectedIndexChange={setIndex}
            onSubmit={s => setStep({ kind: 'detail', name: s.name })}
            emptyText="No MCP servers yet: a adds one (catalog, npm, Python or a URL)."
            onKey={(input, _key, s) => {
              if (input === 'a') { setValues({}); setErrors({}); setStep({ kind: 'source' }); return true }
              if (!s) return false
              if (input === 'r') { void restart(s.name); return true }
              if (input === 'd') { setStep({ kind: 'remove', name: s.name }); return true }
              if (input === 'e') { setValues({}); setErrors({}); setStep({ kind: 'env', name: s.name }); return true }
              if (input === 'l') { setStep({ kind: 'logs', name: s.name }); return true }
              return false
            }}
            renderItem={(s, { selected: current }) => {
              const live = stateOf(s.name)
              return (
                <Text wrap="truncate-end" inverse={theme.mono && current}>
                  <Text color={current ? theme.color.accent : theme.color.dim}>{current ? theme.glyph.pointer : ' '} </Text>
                  <Text bold={current} color={current ? theme.color.accent : theme.color.text}>{truncate(s.name, 22).padEnd(23)}</Text>
                  <Text color={statusColor(live)}>{`${statusGlyph(live)} ${live?.status ?? 'not running'}`.padEnd(15)}</Text>
                  <Text color={theme.color.muted}>{`${live?.toolCount ?? s.available_tools?.length ?? 0} tools`.padEnd(10)}</Text>
                  <Text color={theme.color.dim}>{runsOnText(s)}{live?.error ? `  ${live.error}` : ''}</Text>
                </Text>
              )
            }}
          />
        )}
        {selected && stateOf(selected.name)?.error ? <Text color={theme.color.error} wrap="wrap">{truncate(stateOf(selected.name)!.error!, inner * 2)}</Text> : null}
      </Modal>
    )
  }

  if (step.kind === 'source') {
    return (
      <Modal title={`Add an MCP server ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={[{ keys: 'up down', label: 'move' }, { keys: '/', label: 'filter' }, { keys: 'enter', label: 'choose' }, { keys: 'esc', label: direct ? 'close' : 'back' }]}>
        <List
          items={sources}
          getKey={r => (r.entry ? `catalog:${r.entry.name}` : r.kind)}
          height={Math.max(3, Math.min(sources.length, height - 9))}
          width={inner}
          keyLayer="overlay"
          selectedIndex={index}
          onSelectedIndexChange={setIndex}
          filter={(r, q) => `${r.label} ${r.entry?.name ?? ''} ${r.entry?.category ?? ''} ${r.detail}`.toLowerCase().includes(q.toLowerCase())}
          onSubmit={r => { setValues(initialForm(r)); setErrors({}); setFormError(null); setStep({ kind: 'form', row: r }) }}
          renderItem={(r, { selected }) => (
            <Text wrap="truncate-end" inverse={theme.mono && selected}>
              <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
              <Text bold={selected} color={selected ? theme.color.accent : r.entry ? theme.color.text : theme.color.info}>{truncate(r.label, 24).padEnd(25)}</Text>
              <Text color={theme.color.muted}>{(r.entry ? r.entry.category : 'custom').padEnd(14)}</Text>
              <Text color={theme.color.dim}>{r.detail}</Text>
            </Text>
          )}
        />
      </Modal>
    )
  }

  if (step.kind === 'form') {
    const row = step.row
    const blocked = studioOnlyReason(row)
    if (blocked) {
      return (
        <Modal title={row.label} width={dialogWidth} onClose={() => (props.add !== undefined ? close() : setStep({ kind: 'source' }))} hints={[{ keys: 'esc', label: 'back' }]}>
          <Text wrap="wrap" color={theme.color.warn}>{blocked}</Text>
        </Modal>
      )
    }
    const keys = envKeysOf(row)
    const isHttp = row.kind === 'http' || !!row.entry?.url
    const fields: FieldSpec[] = [
      { kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. github', hint: 'Its tools are named mcp_<name>_<tool>' },
      { kind: 'text', key: 'source', label: row.kind === 'http' ? 'URL' : 'Package', placeholder: row.kind === 'http' ? 'https://…/mcp' : row.kind === 'python' ? 'mcp-server-fetch' : '@scope/server-name', hidden: !!row.entry },
      { kind: 'text', key: 'args', label: 'Arguments', placeholder: 'optional, space-separated', hint: row.entry?.args?.length ? 'Fill in the {placeholders}' : undefined, hidden: isHttp || (!!row.entry && !row.entry.args?.length) },
      {
        kind: 'choice',
        key: 'runOn',
        label: 'Runs on',
        options: [{ value: 'container', label: 'container (default: isolated from your machine)' }, ...(hostAllowed ? [{ value: 'host', label: 'host (this machine: files, apps, your login state)' }] : [])],
        hint: hostAllowed ? '←→ host only when the server needs your machine' : 'Host needs host access on the agent (compute.host_access)',
        hidden: isHttp,
      },
      ...keys.map((k): FieldSpec => ({ kind: 'text', key: `env:${k.key}`, label: k.key, placeholder: k.required ? 'required' : 'optional', hint: 'Sealed in the agent’s identity store, never in its config', mask: true })),
      { kind: 'text', key: 'extraEnv', label: 'Env', placeholder: 'optional KEY=value …', hint: 'Other env vars the server reads; sealed like the rest', mask: true, hidden: !!row.entry },
    ]
    const notes = [row.entry?.prerequisite, row.entry?.advisory].filter((n): n is string => !!n)
    return (
      <Modal title={`${row.label} ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={[{ keys: 'enter', label: 'next / add' }, { keys: 'ctrl+s', label: 'add' }, { keys: 'esc', label: 'cancel' }]}>
        <Text color={theme.color.muted} wrap="wrap">{row.entry ? row.entry.description : row.detail}</Text>
        {notes.map((n, i) => <Text key={i} color={theme.color.warn} wrap="wrap">{theme.glyph.warn} {n}</Text>)}
        {row.entry?.repo ? <Text color={theme.color.dim} wrap="truncate-end">{row.entry.repo}</Text> : null}
        <Box marginTop={1} flexDirection="column">
          <Form
            fields={fields}
            values={values}
            onChange={v => { setValues(v); setFormError(null) }}
            errors={errors}
            onSubmit={() => { void add(row) }}
            onCancel={() => (props.add !== undefined ? close() : setStep({ kind: 'source' }))}
            width={inner}
            height={Math.max(4, Math.min(14, height - 12))}
            cancelLabel="go back"
          />
        </Box>
        {formError ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {formError}</Text> : null}
      </Modal>
    )
  }

  const name = step.name
  const server = serverOf(name)
  const live = stateOf(name)

  if (step.kind === 'env') {
    const keys = server ? serverEnvKeys(server) : []
    const fields: FieldSpec[] = keys.map(key => ({ kind: 'text', key: `env:${key}`, label: key, placeholder: 'stored · type to replace', mask: true }))
    return (
      <Modal title={`${name} credentials ${theme.glyph.sep} ${who}`} width={dialogWidth} onClose={keys.length ? undefined : () => setStep({ kind: 'detail', name })} hints={[{ keys: 'enter', label: 'next / save' }, { keys: 'ctrl+s', label: 'save + reconnect' }, { keys: 'esc', label: 'cancel' }]}>
        {keys.length === 0 ? <Text color={theme.color.muted} wrap="wrap">{name} takes no credentials.</Text> : (
          <Form
            fields={fields}
            values={values}
            onChange={setValues}
            errors={errors}
            onSubmit={() => { void saveEnv(name) }}
            onCancel={() => setStep({ kind: 'detail', name })}
            width={inner}
            height={Math.max(3, Math.min(12, keys.length * 2 + 1))}
            cancelLabel="go back"
          />
        )}
        {errors.form ? <Text color={theme.color.warn}>{errors.form}</Text> : null}
      </Modal>
    )
  }

  if (step.kind === 'remove') {
    return (
      <Modal title={`Remove ${name}`} width={dialogWidth} hints={step.busy ? [] : [{ keys: 'y enter', label: 'Remove' }, { keys: 'n esc', label: 'Keep' }]}>
        <Text color={theme.color.warn} wrap="wrap">Remove {name} from {who}? Its tools go away and its stored credentials are deleted from the agent.</Text>
        {step.busy ? <Spinner label="removing…" /> : null}
      </Modal>
    )
  }

  if (step.kind === 'logs') {
    const lines: Line[] = (live?.logs ?? []).map(l => [
      { text: `${formatClock(l.timestamp)} `, tone: 'dim' },
      { text: `${l.stream.padEnd(7)}`, tone: l.stream === 'stderr' ? 'warn' : l.stream === 'system' ? 'muted' : 'text' },
      { text: l.message },
    ])
    if (live?.error) lines.push([{ text: 'error   ', tone: 'error' }, { text: live.error, tone: 'error' }])
    return (
      <Modal title={`${name} logs ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={[{ keys: 'up down', label: 'scroll' }, { keys: 'esc', label: 'back' }]}>
        <LinesView lines={lines} width={inner} height={Math.max(4, height - 8)} keyLayer="overlay" follow emptyText={live ? 'No log lines yet.' : `${name} is not running: start the agent, or r restart from its details.`} />
      </Modal>
    )
  }

  if (step.kind === 'tools') {
    const decls = serverToolDecls(config?.tools as Array<{ name: string; enabled?: boolean }> | undefined, name)
    return (
      <Modal title={`${name} tools ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={[{ keys: 'space', label: 'on / off' }, { keys: 'esc', label: 'back' }]}>
        <List
          items={decls}
          getKey={d => d.name}
          height={Math.max(1, Math.min(decls.length || 1, height - 9))}
          width={inner}
          keyLayer="overlay"
          emptyText="No tools yet: they are listed once the server connects."
          onKey={(input, _key, d) => { if (input === ' ' && d) { void toggleTool(d.name); return true } return false }}
          onSubmit={d => { void toggleTool(d.name) }}
          renderItem={(d, { selected }) => (
            <Text wrap="truncate-end" inverse={theme.mono && selected}>
              <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
              <Text color={d.enabled ? theme.color.success : theme.color.dim}>{d.enabled ? `[${theme.ascii ? 'x' : theme.glyph.check}] ` : '[ ] '}</Text>
              <Text bold={selected} color={selected ? theme.color.accent : theme.color.text}>{d.tool}</Text>
            </Text>
          )}
        />
      </Modal>
    )
  }

  if (step.kind === 'work') {
    const outcome = step.outcome
    const glyph = (s: StepStatus) => (s === 'done' ? theme.glyph.check : s === 'failed' ? theme.glyph.cross : s === 'skipped' ? theme.glyph.ring : s === 'running' ? '' : theme.glyph.ring)
    const color = (s: StepStatus) => (s === 'done' ? theme.color.success : s === 'failed' ? theme.color.error : s === 'skipped' ? theme.color.warn : theme.color.muted)
    const tools = live?.toolCount ?? outcome?.toolsDiscovered ?? 0
    return (
      <Modal title={`${name} ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={step.done ? [{ keys: 'l', label: 'logs' }, { keys: 'r', label: 'restart' }, { keys: 'enter esc', label: direct ? 'close' : 'back' }] : []}>
        {step.steps.map((s, i) => (
          <Box key={i} flexDirection="column">
            {s.status === 'running'
              ? <Spinner label={s.label} />
              : <Text color={color(s.status)} wrap="truncate-end">{glyph(s.status)} {s.label}{s.status === 'pending' ? '' : ''}</Text>}
            {s.note ? <Text color={s.status === 'failed' ? theme.color.error : theme.color.dim} wrap="wrap">{'  '}{s.note}</Text> : null}
          </Box>
        ))}
        {step.done && outcome?.hostDenied ? <Text color={theme.color.warn} wrap="wrap">{theme.glyph.warn} Asked for the host, ran in a container: {outcome.hostDenied}</Text> : null}
        {step.done && outcome?.stderrTail?.length ? <Text color={theme.color.dim} wrap="wrap">{outcome.stderrTail.slice(-3).join('\n')}</Text> : null}
        {step.done && tools > 0 ? <Text color={theme.color.muted} wrap="wrap">{tools} tools, named mcp_{name}_…; new ones start restricted (the agent asks before using them). d in its details removes it; t turns tools on and off.</Text> : null}
        {step.done && step.steps.some(s => s.status === 'skipped') ? <Text color={theme.color.muted} wrap="wrap">It connects when {who} starts: /start {who}.</Text> : null}
      </Modal>
    )
  }

  // detail
  const decls = serverToolDecls(config?.tools as Array<{ name: string; enabled?: boolean }> | undefined, name)
  const on = decls.filter(d => d.enabled).length
  const source = server?.transport === 'http' ? server.url : server?.npm_package ? `npm ${server.npm_package}` : server?.pypi_package ? `uvx ${server.pypi_package}` : [server?.command, ...(server?.args ?? [])].filter(Boolean).join(' ')
  const tail = (live?.logs ?? []).slice(-Math.max(0, Math.min(6, height - 20)))
  return (
    <Modal title={`${name} ${theme.glyph.sep} ${who}`} width={dialogWidth} hints={[{ keys: 'r', label: 'restart' }, { keys: 't', label: 'tools' }, { keys: 'e', label: 'credentials' }, { keys: 'l', label: 'logs' }, { keys: 'd', label: 'remove' }, { keys: 'esc', label: direct ? 'close' : 'back' }]}>
      {!server ? <Text color={theme.color.warn}>{who} has no server named {name}.</Text> : (
        <>
          <Text wrap="truncate-end"><Text color={theme.color.muted}>{'state   '}</Text><Text color={statusColor(live)}>{statusGlyph(live)} {live?.status ?? 'not running (starts with the agent; r connects it now)'}</Text>{live?.restartCount ? <Text color={theme.color.dim}>{`  ${live.restartCount} restarts`}</Text> : null}</Text>
          {live?.error ? <Text wrap="wrap" color={theme.color.error}>{'        '}{live.error}</Text> : null}
          <Text wrap="truncate-end"><Text color={theme.color.muted}>{'source  '}</Text><Text>{source || '-'}</Text></Text>
          <Text wrap="truncate-end"><Text color={theme.color.muted}>{'runs on '}</Text><Text>{runsOnText(server)}</Text></Text>
          <Text wrap="truncate-end"><Text color={theme.color.muted}>{'tools   '}</Text><Text>{decls.length ? `${on} on / ${decls.length}` : `${live?.toolCount ?? 0}`}</Text><Text color={theme.color.dim}>{'  t turns them on and off'}</Text></Text>
          {serverEnvKeys(server).length ? <Text wrap="truncate-end"><Text color={theme.color.muted}>{'env     '}</Text><Text>{serverEnvKeys(server).join(', ')}</Text><Text color={theme.color.dim}>{'  (values sealed; e replaces)'}</Text></Text> : null}
          {tail.length ? <Box marginTop={1} flexDirection="column">{tail.map((l, i) => <Text key={i} wrap="truncate-end" color={l.stream === 'stderr' ? theme.color.warn : theme.color.dim}>{formatClock(l.timestamp)} {l.message}</Text>)}</Box> : null}
        </>
      )}
    </Modal>
  )
}

function initialForm(row: McpSourceRow, value = ''): FormValues {
  return {
    name: defaultServerName(row, value),
    source: row.entry ? '' : value,
    args: joinArgs(row.entry?.args),
    runOn: row.entry && !row.entry.url && row.entry.runLocation === 'host' ? 'host' : 'container',
    extraEnv: '',
  }
}

/** `KEY=value KEY2="with space"` → pairs (values may be quoted). */
export function parseEnvPairs(text: string): Array<[string, string]> {
  const parts: string[] = []
  const pattern = /([A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S*))|\S+/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) parts.push(m[0])
  return parts.map(raw => {
    const at = raw.indexOf('=')
    if (at <= 0) return null
    const value = raw.slice(at + 1)
    const unquoted = /^".*"$/.test(value) ? value.slice(1, -1).replace(/\\(.)/g, '$1') : /^'.*'$/.test(value) ? value.slice(1, -1) : value
    return [raw.slice(0, at), unquoted] as [string, string]
  }).filter((p): p is [string, string] => !!p && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p[0]))
}
