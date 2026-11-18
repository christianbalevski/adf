import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Vendored from adf-org/brand (scripts/check-brand-tokens.mjs); not ours to lint.
  { ignores: ['src/renderer/lib/brand/orbital.js'] },
  // Bundled output of tools/alf-mcp (gitignored).
  { ignores: ['tools/**/.build/**'] },
  {
    ignores: ['dist/**', 'out/**'],
    linterOptions: {
      // The repository predates ESLint. Existing suppressions are cleaned up as
      // their surrounding files enter the enforced ruleset.
      reportUnusedDisableDirectives: 'off',
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts under tools/ (e.g. the alf-mcp launcher).
    files: ['tools/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // tools/ shares the src/ baseline: it imports runtime modules directly
    // (tools/alf-mcp reuses the crypto and pipeline code) and follows its style.
    files: ['src/**/*.{ts,tsx}', 'tools/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // TypeScript resolves names; typescript-eslint recommends this off.
      'no-undef': 'off',
      // Control characters in regexes here are deliberate (stripping terminal
      // escapes and C0 controls from names and paths).
      'no-control-regex': 'off',
      // Lazy require() is deliberate: guarded electron loads keep the npm
      // bundle electron-free, and adapter packages install at runtime.
      '@typescript-eslint/no-require-imports': 'off',
      // A closure may read a let before its one assignment (timers, callbacks).
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // The TypeScript version below replaces it.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true, destructuredArrayIgnorePattern: '^_' }],
      // Backlog, held by scripts/check-ratchet.mjs (the `any` count) until it
      // reaches zero and this rule can turn on.
      '@typescript-eslint/no-explicit-any': 'off',
      // Backlog (about 150 effects). Fixing one can change when it runs, so it
      // gets its own change. The plugin stays loaded so existing suppressions
      // stay valid.
      'react-hooks/exhaustive-deps': 'off',
      // On for React code below; main-process functions may be named use*.
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // React code. Hooks named use* are React hooks; plain functions are not.
    files: ['src/renderer/**/*.{ts,tsx}', 'src/web/**/*.{ts,tsx}', 'src/main/tui/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // Agent-reachable code: tools and the code sandbox. Provider keys and
    // owner secrets reach a model only through the runtime's provider, never
    // through anything an agent can call or run.
    files: ['src/main/tools/**/*.ts', 'src/main/runtime/code-sandbox.ts', 'src/main/runtime/sandbox-*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [{
          regex: '(^|/)(settings\\.service|provider-key-store|provider-key-vault|owner-secret-store|secret-storage-[a-z-]+|daemon-secrets|mcp-oauth-store)$',
          allowTypeImports: true,
          message: "Agent-reachable code must not import app secret stores. An agent's own credentials live in adf_identity; app-level provider keys are used only by the runtime's provider (model_invoke).",
        }],
      }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "MemberExpression[property.name='name']:matches([object.name='config'], [object.property.name='config'])",
          message: "An agent's name is its .adf file name. Use agentNameOf(filePath) from stores/failure-notices.store; config.name is a synced copy that runs ahead during a deferred rename.",
        },
        {
          selector: 'Literal[value=/your instructions/i], TemplateElement[value.raw=/your instructions/i], JSXText[value=/your instructions/i]',
          message: "Say \"agent instructions\". The owner configures many agents, so \"your\" is ambiguous between the owner and the agent.",
        },
        {
          // Phrasings the owner has rejected in review (plain UI copy).
          selector: [
            'Literal[value=/where it runs|who can attach|setup needed|you and agents|priced per layer|unbriefed/i]',
            'TemplateElement[value.raw=/where it runs|who can attach|setup needed|you and agents|priced per layer|unbriefed/i]',
            'JSXText[value=/where it runs|who can attach|setup needed|you and agents|priced per layer|unbriefed/i]',
          ].join(', '),
          message: 'UI copy names the thing ("Location", "Agent access", "Prerequisite"); option labels are values ("Host" / "Container"). No conversational phrases, metaphors or coined terms.',
        },
      ],
    },
  },
)
