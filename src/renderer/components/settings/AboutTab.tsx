/**
 * About tab — concise overview of what ADF is, what's inside an .adf file,
 * how to get started, and what the runtime can do. Replaces the old
 * `AboutDialog` modal.
 *
 * Keep this short — it's a primer, not a manual. Anything that drifts
 * with the codebase should live in code/docs, not here.
 */

import { useEffect, useState } from 'react'

const REPO_URL = 'https://github.com/christianbalevski/adf'
const RELEASES_URL = `${REPO_URL}/releases/latest`

export function AboutTab() {
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    window.adfApi?.getAppVersion()
      .then((version) => {
        if (active) setAppVersion(version)
      })
      .catch(() => {
        if (active) setAppVersion('Unavailable')
      })

    return () => {
      active = false
    }
  }, [])

  const openExternal = (url: string) => {
    // Electron renderer has no `shell.openExternal` directly — fall back
    // to anchor click behaviour; the main process intercepts and routes
    // to the OS handler via the default window.open behaviour.
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="space-y-6 text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
      {/* Running version + updates */}
      <section
        aria-label="ADF Studio version"
        className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/60"
      >
        <div>
          <p className="font-medium text-neutral-800 dark:text-neutral-100">ADF Studio</p>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400" aria-live="polite">
            Version {appVersion ?? '…'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => openExternal(RELEASES_URL)}
          className="shrink-0 text-xs font-medium text-blue-500 hover:text-blue-700 hover:underline dark:hover:text-blue-400 inline-flex items-center gap-1"
        >
          <span>Check for updates</span>
          <span aria-hidden>↗</span>
        </button>
      </section>

      {/* Hero */}
      <div className="text-center pb-2">
        <div className="text-4xl mb-2">📄</div>
        <h3 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
          Agent Document Format
        </h3>
        <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
          An open standard for portable AI agents
        </p>
      </div>

      {/* The core idea */}
      <section>
        <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">The core idea</h4>
        <p>
          ADF is an open standard for portable AI agents. A single SQLite file
          (<strong>.adf</strong>) contains a complete agent: identity, memory,
          instructions, tools, and execution state. Move the file, you move
          the agent.
        </p>
        <p className="mt-2">
          The thesis: ADF is less about what an agent can <em>do</em> and more
          about what an agent <em>is</em>. If an agent is a file with a defined
          shape, any runtime conforming to the spec can run it — the same way
          any photo viewer can open a JPEG. ADF Studio is the reference
          implementation; the runtime, daemon, and CLI ship alongside it.
        </p>
      </section>

      {/* What's inside */}
      <section>
        <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">What's inside an .adf file?</h4>
        <ul className="space-y-1.5 ml-1 text-xs text-neutral-600 dark:text-neutral-400">
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">README</strong> — the agent's public-facing description (markdown). Editable by you and the agent.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Memory</strong> — the agent's private working state.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Config</strong> — model, instructions, tools, triggers, security, and runtime behavior.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Loop</strong> — full conversation history and context.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Inbox &amp; outbox</strong> — messages exchanged with other agents.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Files</strong> — internal file storage scoped to the agent.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Identity</strong> — a cryptographic DID for peer authentication.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Tasks &amp; logs</strong> — background work and operational records.
          </li>
        </ul>
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Share the file, share the agent — work, memory, history, and identity all in one place.
        </p>
      </section>

      {/* How to use */}
      <section>
        <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">How to use ADF</h4>
        <ol className="space-y-2 list-decimal list-inside text-neutral-600 dark:text-neutral-400 text-xs">
          <li>
            <strong>Connect a provider</strong> — In Settings → Providers, add an
            Anthropic, OpenAI, OpenAI-compatible, OpenRouter, or ChatGPT Subscription provider.
          </li>
          <li>
            <strong>Create or open an .adf</strong> — Use <em>+ New .adf</em> on the
            home screen, or open an existing file.
          </li>
          <li>
            <strong>Configure the agent</strong> — Set its instructions, model, and
            tools in the Config tab.
          </li>
          <li>
            <strong>Run it</strong> — Chat with the agent directly, or enable
            auto-start / autonomous mode to let it run on its own.
          </li>
          <li>
            <strong>Track directories</strong> — Add a folder to the Tracked
            Directories panel so the home screen sees all your .adf files at a glance.
          </li>
        </ol>
      </section>

      {/* Capabilities */}
      <section>
        <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">What agents can do</h4>
        <ul className="space-y-1.5 ml-1 text-xs text-neutral-600 dark:text-neutral-400">
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Code execution</strong> — sandboxed JavaScript via <code>sys_code</code> and <code>sys_lambda</code>, with optional npm packages.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">MCP integration</strong> — connect to Model Context Protocol servers for filesystem, web, GitHub, Slack, and more.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Compute containers</strong> — isolate each agent in its own podman container, with optional host-process access.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Channels</strong> — connect agents to Email, Telegram, or Discord.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">ALF mesh</strong> — agents message each other's inboxes over the Agent Loop Format protocol and discover peers via mDNS.
          </li>
          <li>
            <strong className="text-neutral-800 dark:text-neutral-100">Triggers &amp; timers</strong> — run on schedule, on file change, on inbox arrival, on tool calls, and more.
          </li>
        </ul>
      </section>

      {/* Status */}
      <section>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          ADF is an early public release. The format and APIs may change as the
          spec, runtime, and Studio evolve in the open.
        </p>
      </section>

      {/* Credits + repo */}
      <section className="pt-3 border-t border-neutral-200 dark:border-neutral-800">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Created by{' '}
            <span className="font-medium text-neutral-700 dark:text-neutral-200">
              Christian Balevski
            </span>
            .
          </p>
          <button
            type="button"
            onClick={() => openExternal(REPO_URL)}
            className="text-xs text-blue-500 hover:text-blue-700 hover:underline inline-flex items-center gap-1"
          >
            <span>github.com/christianbalevski/adf</span>
            <span aria-hidden>↗</span>
          </button>
        </div>
      </section>
    </div>
  )
}
