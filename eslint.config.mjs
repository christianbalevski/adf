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
      // Legacy-baseline exemptions. The rest of the JavaScript and TypeScript
      // recommended correctness rules remain enforced repository-wide.
      'no-control-regex': 'off',
      'no-undef': 'off',
      'no-unsafe-finally': 'off',
      'no-useless-escape': 'off',
      'no-unused-vars': 'off',
      'prefer-const': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // Existing React code has a hooks backlog. Keep the plugin loaded so
      // local suppressions are valid without pretending those rules are green.
      'react-hooks/exhaustive-deps': 'off',
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
      ],
    },
  },
)
