/**
 * The three templates Studio ships.
 *
 * Each one is written out as an ordinary `.adf` in `<userData>/templates` the
 * first time the templates folder is listed, and again on "Reset to shipped".
 * The `template` here is an AgentTemplate (overrides over DEFAULT_AGENT_CONFIG),
 * so anything not named below keeps tracking the code default across releases.
 *
 * Tool lists are whole lists, not patches (see mergeAgentTemplate), so the
 * builders below start from DEFAULT_TOOLS and change only the named entries.
 *
 * Out of reach here on purpose: `security.allow_local_fetch` and `stream_bind`
 * are locked in code (DEFAULT_LOCKED_PATHS in sys-update-config.tool.ts) for
 * every agent, so no template can pre-grant them.
 */

import type { AgentTemplate, ToolDeclaration } from '../types/adf-v02.types'
import { DEFAULT_TOOLS } from '../types/adf-v02.types'

/** The three ids. Mirrors ShippedTemplateId in ipc.types (kept local so this file has no IPC dependency). */
export type ShippedTemplateId = 'standard' | 'sandboxed' | 'full-access'

export interface ShippedTemplate {
  id: ShippedTemplateId
  /** config.name of the generated file, and what the UI shows. */
  name: string
  /**
   * One literal sentence about the TEMPLATE, written to adf_meta
   * `adf_template_description`. It never becomes the agent's own description:
   * an agent made from a template describes itself.
   */
  description: string
  /**
   * A caution shown wherever the template is offered (adf_meta
   * `adf_template_warning`). Absent for a template that grants nothing unusual.
   */
  warning?: string
  /** Seed README.md of the template file. States what the template grants. */
  readme: string
  /** Overrides over DEFAULT_AGENT_CONFIG. `{}` means the code defaults. */
  template: AgentTemplate
}

/**
 * DEFAULT_TOOLS with the named entries changed. Tools absent from the defaults
 * (npm_install) are appended in declaration order after the defaults.
 */
function toolsWith(
  changes: Record<string, Partial<ToolDeclaration>>,
  extra: ToolDeclaration[] = []
): ToolDeclaration[] {
  const base = DEFAULT_TOOLS.map((tool) =>
    changes[tool.name] ? { ...tool, ...changes[tool.name] } : { ...tool }
  )
  const known = new Set(base.map((t) => t.name))
  for (const tool of extra) {
    if (!known.has(tool.name)) base.push({ ...tool })
  }
  return base
}

const STANDARD_README = `# Standard

The template new agents start from unless you pick another one.

It is the code default, with nothing changed. Code execution and web fetch are
on, container compute and host access are off, and every escalation, such as a
config change or a package install, still asks you first.

Edit this file to change what every new agent starts with, or use "Reset to
shipped" to put it back.
`

const SANDBOXED_README = `# Sandboxed

An agent that can read and write its own files, talk to you, and message other
agents, and nothing else.

Off in this template: code execution (\`sys_code\`, \`sys_lambda\`), web fetch
(\`sys_fetch\`), package installs (\`npm_install\`), MCP server installs
(\`mcp_install\`), container compute and host access.

The guard block is unchanged: the escalations that stay on, such as
\`sys_update_config\`, still ask you before they run, and an agent can still ask
you to turn any of the above back on.
`

const FULL_ACCESS_README = `# Full access

An agent that runs code, fetches the web, uses a container and the host machine,
installs packages and MCP servers, and changes its own config, without asking
you first.

On in this template, with no approval prompt: \`sys_code\`, \`sys_lambda\`,
\`sys_fetch\`, \`compute_exec\`, \`npm_install\`, \`mcp_install\` and
\`sys_update_config\`. Container compute is enabled and host access is granted.

The guard block is unchanged: \`security.allow_local_fetch\` and stream binding
are locked in code for every agent, so this template does not grant them.

Start agents from this template only for work you would run yourself.
`

/**
 * Standard: the code defaults, no overrides. Written out as a file so it can be
 * edited like any other template; an untouched copy diffs to nothing.
 */
const STANDARD: ShippedTemplate = {
  id: 'standard',
  name: 'Standard',
  description: 'The code defaults: code execution and web fetch on, compute off, escalations ask first.',
  readme: STANDARD_README,
  template: {}
}

const SANDBOXED: ShippedTemplate = {
  id: 'sandboxed',
  name: 'Sandboxed',
  description: 'No code execution, no web fetch, no package or MCP installs, no compute and no host access.',
  readme: SANDBOXED_README,
  template: {
    tools: toolsWith(
      {
        sys_code: { enabled: false, visible: false },
        sys_lambda: { enabled: false, visible: false },
        sys_fetch: { enabled: false, visible: false },
        mcp_install: { enabled: false, visible: false },
        compute_exec: { enabled: false, visible: false }
      },
      [{ name: 'npm_install', enabled: false, visible: false }]
    ),
    compute: { enabled: false, host_access: false }
  }
}

const FULL_ACCESS: ShippedTemplate = {
  id: 'full-access',
  name: 'Full access',
  description: 'Code execution, web fetch, compute, host access, package and MCP installs and config changes, with no approval prompt.',
  warning: 'Runs code, reaches the network and your host, and changes its own settings without asking.',
  readme: FULL_ACCESS_README,
  template: {
    tools: toolsWith(
      {
        sys_code: { enabled: true, visible: true, restricted: false },
        sys_lambda: { enabled: true, visible: true, restricted: false },
        sys_fetch: { enabled: true, visible: true, restricted: false },
        compute_exec: { enabled: true, visible: true, restricted: false },
        mcp_install: { enabled: true, visible: true, restricted: false },
        sys_update_config: { enabled: true, visible: true, restricted: false }
      },
      [{ name: 'npm_install', enabled: true, visible: true, restricted: false }]
    ),
    compute: { enabled: true, host_access: true }
  }
}

export const SHIPPED_TEMPLATES: ShippedTemplate[] = [STANDARD, SANDBOXED, FULL_ACCESS]

export const SHIPPED_TEMPLATE_IDS: ShippedTemplateId[] = SHIPPED_TEMPLATES.map((t) => t.id)

export function getShippedTemplate(id: string): ShippedTemplate | undefined {
  return SHIPPED_TEMPLATES.find((t) => t.id === id)
}

export function isShippedTemplateId(id: string): id is ShippedTemplateId {
  return SHIPPED_TEMPLATES.some((t) => t.id === id)
}

/** The template used when settings name none. */
export const DEFAULT_SHIPPED_TEMPLATE_ID: ShippedTemplateId = 'standard'

/** adf_meta key stamped on a generated shipped template file; its value is the id. */
export const SHIPPED_TEMPLATE_META_KEY = 'adf_template_shipped'

/**
 * adf_meta keys holding a template's own notes: what the template is for, and
 * a caution shown wherever it is offered. They describe the TEMPLATE, so
 * instantiate drops them exactly as it drops the shipped marker; a duplicate
 * keeps them.
 */
export const TEMPLATE_DESCRIPTION_META_KEY = 'adf_template_description'
export const TEMPLATE_WARNING_META_KEY = 'adf_template_warning'

/** Longest either note may be. */
export const TEMPLATE_NOTE_MAX_LENGTH = 500
