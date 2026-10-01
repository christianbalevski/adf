import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { useSyncExternalStore } from 'react'
import type { HighlighterCore, LanguageRegistration } from 'shiki/core'
import { createIncrementalRenderer } from './markdown-split'

/**
 * The one sanitized markdown → HTML path in the renderer.
 *
 * Everything this renders is untrusted: model output in the loop, a peer's
 * files, a SKILL.md fetched from a catalog nobody in this process controls. So
 * the parse is always followed by DOMPurify with the same allowlist rather than
 * by any per-caller variation — `marked` does not sanitize, and a second copy of
 * this configuration is a second chance to get it wrong.
 *
 * Callers own their own pre-processing (the loop percent-encodes adf-file://
 * URLs, the skill preview strips control characters) and pass the result here.
 */

// ── Code highlighting (Shiki) ───────────────────────────────────────────────
//
// Fenced code blocks are coloured by Shiki (github-light / github-dark-dimmed,
// BRAND.md §10). Shiki is loaded on demand — core + the JavaScript regex
// engine (no WASM, so the CSP needs no 'wasm-unsafe-eval') and one grammar per
// language the first time a block asks for it.
//
// Rendering stays synchronous: a block is highlighted only when the
// highlighter and its grammar are already loaded; otherwise it renders as
// plain code, the load starts, and when it lands `useMarkdownHighlightVersion`
// ticks so mounted documents re-render once. A fence that has not closed yet
// (an answer still streaming) is never highlighted, so a growing block costs
// no more than it did before and colours in once, when it closes.
//
// Both themes are emitted as CSS variables (`--shiki-light`, `--shiki-dark`,
// `defaultColor: false`); editor.css picks one by the `.dark` class, so a
// theme switch needs no re-render.
//
// Shiki's markup carries inline `style` attributes, which the sanitizer
// forbids. Highlighted blocks are therefore swapped out for an unguessable
// placeholder before sanitizing and spliced back afterwards: the sanitizer
// only ever sees model text, and Shiki's output (which escapes the code it
// tokenizes) never passes through it.

type LanguageModule = { default: LanguageRegistration[] }

/** Grammar id → loader. Ids are the grammars' own `name`s. */
const GRAMMARS: Record<string, () => Promise<LanguageModule>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
}

/** Fence info-string → grammar id, for the names people actually write. */
const ALIASES: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  json5: 'json', jsonc: 'json',
  bash: 'shellscript', sh: 'shellscript', shell: 'shellscript', zsh: 'shellscript',
  py: 'python', python3: 'python',
  yml: 'yaml',
  md: 'markdown',
  patch: 'diff',
  htm: 'html', xhtml: 'html',
  rs: 'rust',
  golang: 'go',
}

/** Blocks above this are left plain: tokenizing them would stall the frame. */
const MAX_HIGHLIGHT_CHARS = 40_000

const THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const

let highlighter: HighlighterCore | null = null
let highlighterLoad: Promise<HighlighterCore | null> | null = null
const loadedLanguages = new Set<string>()
const loadingLanguages = new Map<string, Promise<void>>()
/** Grammars (or `*` for the highlighter itself) that failed: not retried this session. */
const failedLanguages = new Set<string>()
/** A render fell back to plain for want of something still loading. */
let staleRenders = false
let highlightVersion = 0
const listeners = new Set<() => void>()

function notifyIfStale(): void {
  if (!staleRenders) return
  staleRenders = false
  highlightVersion++
  for (const listener of listeners) listener()
}

function loadHighlighter(): Promise<HighlighterCore | null> {
  highlighterLoad ??= (async () => {
    try {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark-dimmed.mjs'),
      ])
      highlighter = await createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      })
      return highlighter
    } catch (err) {
      // Highlighting is cosmetic: stay on plain code for this session.
      console.warn('[markdown] code highlighter unavailable:', err)
      failedLanguages.add('*')
      return null
    }
  })()
  return highlighterLoad
}

function loadGrammar(id: string): void {
  if (loadedLanguages.has(id) || loadingLanguages.has(id)) return
  const load = (async () => {
    const hl = await loadHighlighter()
    if (!hl) return
    try {
      const grammar = await GRAMMARS[id]()
      await hl.loadLanguage(...grammar.default)
      loadedLanguages.add(id)
    } catch (err) {
      console.warn(`[markdown] grammar "${id}" failed to load:`, err)
      failedLanguages.add(id)
    }
  })().finally(() => {
    loadingLanguages.delete(id)
    notifyIfStale()
  })
  loadingLanguages.set(id, load)
}

function grammarFor(lang: string | undefined): string | null {
  const name = lang?.trim().split(/\s+/, 1)[0]?.toLowerCase()
  if (!name) return null
  const id = ALIASES[name] ?? name
  return id in GRAMMARS ? id : null
}

/** A fenced block whose closing fence has arrived (indented blocks have no lang). */
function isClosedFence(raw: string): boolean {
  const lines = raw.replace(/\s+$/, '').split('\n')
  if (lines.length < 2) return false
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[lines.length - 1])
  return !!open && !!close && close[1][0] === open[1][0] && close[1].length >= open[1].length
}

/**
 * Re-render signal for mounted markdown: changes when a grammar (or the
 * highlighter) that an earlier render had to skip has finished loading.
 * Include it in the deps of whatever memoizes rendered HTML.
 */
export function useMarkdownHighlightVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => highlightVersion
  )
}

/** 128 random bits as hex; model text cannot forge a placeholder it cannot guess. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** Highlighted blocks of the render in progress (set only inside renderMarkdownToSafeHtml). */
let pendingBlocks: string[] | null = null
let placeholderNonce = ''

// Loop messages depend on `breaks`, and one global marked configuration is the
// only kind there is — set it where the sanitizer lives so no caller can render
// through a differently-configured parser.
marked.use({
  async: false,
  breaks: true,
  renderer: {
    code(token: Tokens.Code): string | false {
      if (!pendingBlocks) return false
      const id = grammarFor(token.lang)
      if (!id || !isClosedFence(token.raw) || token.text.length > MAX_HIGHLIGHT_CHARS) return false
      if (failedLanguages.has('*') || failedLanguages.has(id)) return false
      if (!highlighter || !loadedLanguages.has(id)) {
        staleRenders = true
        loadGrammar(id)
        return false
      }
      let html: string
      try {
        html = highlighter.codeToHtml(token.text, { lang: id, themes: THEMES, defaultColor: false })
      } catch {
        return false
      }
      pendingBlocks.push(html)
      return `<div>${placeholderNonce}-${pendingBlocks.length - 1}</div>\n`
    },
  },
})

export function renderMarkdownToSafeHtml(source: string): string {
  const blocks: string[] = []
  pendingBlocks = blocks
  placeholderNonce = `adf-code-${randomToken()}`
  let raw: string
  try {
    raw = marked.parse(source) as string
  } finally {
    pendingBlocks = null
  }
  const safe = DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|adf-file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  })
  if (blocks.length === 0) return safe
  const nonce = placeholderNonce
  return safe.replace(
    new RegExp(`<div>${nonce}-(\\d+)</div>`, 'g'),
    (match, index: string) => blocks[Number(index)] ?? match
  )
}

/**
 * A renderer for ONE growing document (a streaming answer), with the settled
 * prefix's HTML kept between calls.
 *
 * Re-parsing the whole answer on each of the ~20 deltas a second the loop
 * delivers is quadratic in its length; here each delta only re-parses the block
 * still being written, and each finished block is parsed exactly once. The
 * first call — and any call whose text is not simply the previous text plus
 * more — parses the whole thing, so a log row that never streams (history, a
 * re-read transcript) behaves exactly as it always did. A highlight-version
 * change also starts over, so settled blocks rendered before their grammar
 * loaded pick up their colours.
 *
 * `preprocess` runs per parsed segment; it must be line-local (the loop's
 * adf-file:// percent-encoding is) so applying it per segment matches applying
 * it to the whole document.
 */
export function createIncrementalMarkdownRenderer(
  preprocess: (source: string) => string = (source) => source
): (source: string) => string {
  const render = (source: string): string => renderMarkdownToSafeHtml(preprocess(source))
  let version = highlightVersion
  let incremental = createIncrementalRenderer(render)
  return (source: string): string => {
    if (version !== highlightVersion) {
      version = highlightVersion
      incremental = createIncrementalRenderer(render)
    }
    return incremental(source)
  }
}
