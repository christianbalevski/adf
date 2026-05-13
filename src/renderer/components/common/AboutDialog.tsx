import { Dialog } from './Dialog'

interface AboutDialogProps {
  open: boolean
  onClose: () => void
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="About ADF" wide>
      <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-1 text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">

        {/* Hero */}
        <div className="text-center pb-2">
          <div className="text-4xl mb-2">📄</div>
          <h3 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">Agent Document Format</h3>
          <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">The document is the agent boundary</p>
        </div>

        {/* The core idea */}
        <section>
          <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">The core idea</h4>
          <p>
            What should the boundary of an agent be? How much context should it have? What
            defines its scope? Humans already answered this question — with the <em>document</em>.
          </p>
          <p className="mt-2">
            Documents come in all shapes and sizes. A report, a plan, a set of notes, an
            analysis. Each one naturally defines a boundary around a specific scope of work.
            That boundary is flexible, fluid, and intuitive — we already know how to create,
            share, and organize documents.
          </p>
          <p className="mt-2">
            ADF uses that same paradigm to define the boundary of an agent. An <strong>.adf</strong> file
            is a self-contained archive that bundles a document with an AI agent. The document
            defines what the agent knows, what it works on, and where its scope begins and ends.
            The agent isn't separate from the file — it <em>is</em> the file.
          </p>
        </section>

        {/* What's inside */}
        <section>
          <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">What's inside an .adf file?</h4>
          <div className="space-y-2.5 ml-1">
            <div>
              <p className="font-medium text-neutral-800 dark:text-neutral-100">document.md</p>
              <p className="text-neutral-500 dark:text-neutral-400 text-xs">
                The main working document — a report, notes, analysis, plan, or any written
                artifact. You edit it in the WYSIWYG editor on the left. The agent can also
                read and write to it using its tools.
              </p>
            </div>
            <div>
              <p className="font-medium text-neutral-800 dark:text-neutral-100">mind.md</p>
              <p className="text-neutral-500 dark:text-neutral-400 text-xs">
                The agent's private working memory. It uses this to track what it's done,
                store intermediate reasoning, plan next steps, and maintain context between
                turns. You can view it in the Mind tab, but it's primarily for the agent.
              </p>
            </div>
            <div>
              <p className="font-medium text-neutral-800 dark:text-neutral-100">agent.json</p>
              <p className="text-neutral-500 dark:text-neutral-400 text-xs">
                The agent's configuration — its name, model, instructions, available tools,
                and triggers. You can edit this in the Config tab to change how the agent
                behaves.
              </p>
            </div>
            <div>
              <p className="font-medium text-neutral-800 dark:text-neutral-100">loop (conversation)</p>
              <p className="text-neutral-500 dark:text-neutral-400 text-xs">
                The conversation history between you and the agent, stored inside the file
                so it persists across sessions and travels with the document.
              </p>
            </div>
          </div>
        </section>

        {/* How to use */}
        <section>
          <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">How to use ADF</h4>
          <ol className="space-y-2 list-decimal list-inside text-neutral-600 dark:text-neutral-400 text-xs">
            <li>
              <strong>Set up your API key</strong> — Open Settings (<kbd className="px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 rounded text-[10px] font-mono">Cmd+,</kbd>) and
              enter your Anthropic API key (or configure a custom OpenAI-compatible provider).
            </li>
            <li>
              <strong>Create or open a file</strong> — Click "New Document" to create a fresh .adf
              file, or "Open File" to load an existing one. Use the 3-dot menu on any file to copy, rename, or delete it.
            </li>
            <li>
              <strong>Start the agent</strong> — The agent begins automatically when you open a file.
              It reads its instructions from agent.json and is ready to respond.
            </li>
            <li>
              <strong>Chat with your agent</strong> — Use the Chat panel on the right to send
              messages. The agent will read the document, think, use its tools, and respond.
            </li>
            <li>
              <strong>Edit the document</strong> — Write in the editor as you normally would. The
              agent can see your edits and may respond to them depending on its trigger settings.
            </li>
            <li>
              <strong>Check the Mind</strong> — Switch to the Mind tab to see the agent's internal
              reasoning, plans, and notes. This gives you insight into what the agent is thinking.
            </li>
            <li>
              <strong>Customize the agent</strong> — Use the Config tab to change the agent's name (which renames the file),
              model, instructions, tools, and trigger behavior.
            </li>
            <li>
              <strong>Enable mesh networking</strong> — Track directories with multiple .adf files, then
              enable the mesh to let agents communicate via dedicated channels and manage their message inboxes.
            </li>
          </ol>
        </section>

        {/* The ADF paradigm */}
        <section>
          <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">Why documents?</h4>
          <p className="text-neutral-600 dark:text-neutral-400 text-xs">
            Most agent frameworks define scope through code — tool lists, system prompts,
            hardcoded contexts. ADF takes a different approach: the document <em>is</em> the
            scope. Just as a business plan defines the boundary of a strategy discussion, or a
            research paper defines the boundary of an investigation, an .adf file defines the
            boundary of an agent. The agent reads your work, writes alongside you, remembers
            what happened, and maintains its own internal state — all scoped to the document it
            lives in. When you share an .adf file, you share everything: the work, the agent,
            its memory, and the full conversation history — in one portable file.
          </p>
        </section>

        {/* Multi-agent mesh */}
        <section>
          <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">Multi-agent mesh networking</h4>
          <p className="text-neutral-600 dark:text-neutral-400 text-xs">
            Multiple agents can work together through the mesh system. Each agent has a dedicated
            inbox and can send messages to specific channels (other agents). Messages aren't broadcast —
            they're delivered directly to recipient inboxes. Agents can run autonomously in the background,
            check their inboxes, process messages, and collaborate on complex tasks. The mesh supports
            both local (IPC) and network transports for distributed agent communication.
          </p>
        </section>

        {/* Keyboard shortcuts */}
        <section>
          <h4 className="font-semibold text-neutral-800 dark:text-neutral-100 mb-1.5">Keyboard shortcuts</h4>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
            <div className="flex justify-between">
              <span>Settings</span>
              <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-700 rounded text-[10px] font-mono">Cmd+,</kbd>
            </div>
            <div className="flex justify-between">
              <span>Save</span>
              <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-700 rounded text-[10px] font-mono">Cmd+S</kbd>
            </div>
            <div className="flex justify-between">
              <span>New line in loop</span>
              <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-700 rounded text-[10px] font-mono">Shift+Enter</kbd>
            </div>
            <div className="flex justify-between">
              <span>Send message</span>
              <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-700 rounded text-[10px] font-mono">Enter</kbd>
            </div>
          </div>
        </section>

        {/* Close */}
        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Got it
          </button>
        </div>
      </div>
    </Dialog>
  )
}
