/**
 * Shell AST node types.
 *
 * Grammar:
 *   shell   → chain EOF
 *   chain   → pipeline (('&&'|'||'|';') pipeline)*
 *   pipeline → command ('|' command)*
 *   command  → WORD arg* redirect*
 */

// --- Argument types ---

export interface LiteralArg {
  type: 'literal'
  value: string
}

export interface VariableArg {
  type: 'variable'
  name: string
}

export interface SubstitutionArg {
  type: 'substitution'
  pipeline: PipelineNode
}

export interface QuotedArg {
  type: 'quoted'
  quote: 'single' | 'double'
  parts: ArgumentNode[]  // single-quoted → one LiteralArg; double-quoted → mix of literal + variable + substitution
}

export type ArgumentNode = LiteralArg | VariableArg | SubstitutionArg | QuotedArg

// --- Redirect ---

export interface RedirectNode {
  type: 'in' | 'out' | 'append'
  target: string
}

// --- Heredoc ---

export interface HeredocNode {
  tag: string
  content: string
}

// --- Command ---

export interface CommandNode {
  kind: 'command'
  name: string
  args: ArgumentNode[]
  redirects: RedirectNode[]
  heredoc?: HeredocNode
}

// --- Pipeline ---

export interface PipelineNode {
  kind: 'pipeline'
  stages: CommandNode[]
}

// --- Chain ---

export type ChainOperator = '&&' | '||' | ';'

export interface ChainNode {
  kind: 'chain'
  left: PipelineNode
  operator: ChainOperator
  right: ShellNode
}

// --- Root ---

export type ShellNode = PipelineNode | ChainNode
