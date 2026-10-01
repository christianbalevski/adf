import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'

/**
 * CodeMirror themes matching chat code blocks (BRAND.md §10): GitHub light /
 * GitHub dark dimmed token colours over brand chrome. The chrome reads brand
 * tokens, which already switch with <html data-theme>; only the syntax palette
 * and the `dark` flag differ between the two.
 *
 * Background: --paper for an editable file (the editor IS the main panel);
 * --paper-sunken when read-only, like every other code/file-contents view.
 * The read-only class is added by the editor's readOnly compartment.
 */

export const READ_ONLY_CLASS = 'cm-adf-readonly'

const chrome = {
  '&': {
    backgroundColor: 'var(--paper)',
    color: 'var(--ink)',
  },
  [`&.${READ_ONLY_CLASS}`]: {
    backgroundColor: 'var(--paper-sunken)',
  },
  '.cm-content': {
    caretColor: 'var(--ink)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--ink)',
  },
  '.cm-content ::selection, &.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ink-faint)',
    border: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--ink) 4%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--ink)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--tint)',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--tint)',
    outline: '1px solid var(--rule-strong)',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    color: 'var(--status-deprecated)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--status-draft-bg)',
    outline: '1px solid var(--rule-strong)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--paper-sunken)',
    border: '1px solid var(--rule)',
    color: 'var(--ink-faint)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--paper-raised)',
    color: 'var(--ink)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--rule)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--rule)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--paper-raised)',
    color: 'var(--ink)',
    border: '1px solid var(--rule-strong)',
    borderRadius: '3px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--tint)',
    color: 'var(--ink)',
  },
}

interface Palette {
  fg: string
  comment: string
  keyword: string
  string: string
  constant: string
  entity: string
  tag: string
  variable: string
  regexp: string
  invalid: string
  inserted: string
  deleted: string
  heading: string
}

// Primer scopes as used by the github-light / github-dark-dimmed VS Code
// themes (the same themes Shiki renders chat code with).
const GITHUB_LIGHT: Palette = {
  fg: '#24292e',
  comment: '#6a737d',
  keyword: '#d73a49',
  string: '#032f62',
  constant: '#005cc5',
  entity: '#6f42c1',
  tag: '#22863a',
  variable: '#e36209',
  regexp: '#22863a',
  invalid: '#b31d28',
  inserted: '#22863a',
  deleted: '#b31d28',
  heading: '#005cc5',
}

const GITHUB_DARK_DIMMED: Palette = {
  fg: '#adbac7',
  comment: '#768390',
  keyword: '#f47067',
  string: '#96d0ff',
  constant: '#6cb6ff',
  entity: '#dcbdfb',
  tag: '#8ddb8c',
  variable: '#f69d50',
  regexp: '#8ddb8c',
  invalid: '#ff938a',
  inserted: '#8ddb8c',
  deleted: '#ff938a',
  heading: '#6cb6ff',
}

function highlightStyle(p: Palette): HighlightStyle {
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment },
    {
      tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.operator, t.self],
      color: p.keyword,
    },
    { tag: [t.string, t.special(t.string), t.character, t.docString], color: p.string },
    { tag: [t.regexp, t.escape], color: p.regexp },
    {
      tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.constant(t.name), t.standard(t.name), t.propertyName, t.meta, t.processingInstruction],
      color: p.constant,
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.typeName, t.className, t.namespace, t.attributeName, t.macroName],
      color: p.entity,
    },
    { tag: [t.tagName, t.angleBracket], color: p.tag },
    { tag: [t.definition(t.variableName), t.labelName], color: p.variable },
    { tag: [t.variableName, t.punctuation, t.bracket, t.content], color: p.fg },
    { tag: t.heading, color: p.heading, fontWeight: '600' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: p.string, textDecoration: 'underline' },
    { tag: t.inserted, color: p.inserted },
    { tag: t.deleted, color: p.deleted },
    { tag: t.changed, color: p.variable },
    { tag: t.invalid, color: p.invalid },
  ])
}

export const githubLight: Extension = [
  EditorView.theme(chrome, { dark: false }),
  syntaxHighlighting(highlightStyle(GITHUB_LIGHT)),
]

export const githubDarkDimmed: Extension = [
  EditorView.theme(chrome, { dark: true }),
  syntaxHighlighting(highlightStyle(GITHUB_DARK_DIMMED)),
]

/** The read-only class toggle, for the editor's readOnly compartment. */
export const readOnlyChrome: Extension = EditorView.editorAttributes.of({ class: READ_ONLY_CLASS })
