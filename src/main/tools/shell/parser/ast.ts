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
  /** Expansion operator from ${VAR<op>word} — only '-' and ':-' are supported */
  op?: string
  /** Default word from ${VAR<op>word} */
  word?: string
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
  /** in/out/append: file redirects; dup: fd duplication (2>&1);
   *  discard: /dev/null — drop the stream, no VFS write */
  type: 'in' | 'out' | 'append' | 'dup' | 'discard'
  /** File target (in/out/append only) */
  target?: string
  /** Source fd (defaults: 1 for out/append, 0 for in) */
  fd?: number
  /** Duplication target fd (dup only): fd → targetFd */
  targetFd?: number
}

// --- Heredoc ---

export interface HeredocNode {
  tag: string
  content: string
  /** Tag was quoted (<<'EOF') → body stays literal, no $VAR expansion */
  quoted?: boolean
}

// --- Assignment (VAR=value prefix) ---

export interface AssignmentNode {
  name: string
  /** Value parts, concatenated after resolution (VAR=a$B"c") */
  value: ArgumentNode[]
}

// --- Command ---

export interface CommandNode {
  kind: 'command'
  name: string
  args: ArgumentNode[]
  redirects: RedirectNode[]
  heredoc?: HeredocNode
  /** Leading NAME=value assignments — command-scoped env; bare assignment
   *  (empty name) sets the session variable */
  assignments?: AssignmentNode[]
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
  /** Operator came from `&` (background) — executor runs sequentially and notes it */
  background?: boolean
}

// --- Root ---

export type ShellNode = PipelineNode | ChainNode
