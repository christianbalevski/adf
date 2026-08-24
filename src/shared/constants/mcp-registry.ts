/**
 * Curated registry of well-known MCP servers.
 * Used by the "Add MCP Server" modal's Quick-add cards (McpAddServerModal),
 * which prefill the configuration form from an entry.
 */

export interface McpRegistryEntry {
  /** Short identifier used for tool prefixing */
  name: string
  /** Human-readable display name */
  displayName: string
  /** npm package name (for Node servers) */
  npmPackage?: string
  /** PyPI package name (for Python servers) */
  pypiPackage?: string
  /** Runtime — default 'node' for backward compat */
  runtime?: 'node' | 'python'
  /**
   * CLI args appended after the package. Tokens of the form `{placeholder-name}`
   * (matching REGISTRY_ARG_PLACEHOLDER_RE, i.e. /\{[a-z0-9-]+\}/) mark values
   * the user must fill in before install — the modal renders them as required
   * inputs and substitutes them before registration. Placeholders must never
   * be secrets: argv is world-readable on the host.
   */
  args?: string[]
  /**
   * Remote Streamable HTTP endpoint. Presence makes this a remote entry —
   * npmPackage/pypiPackage/runtime/args are ignored.
   */
  url?: string
  /** Header-name → env-key credential mapping for HTTP entries (e.g. Authorization ← GITHUB_PAT). */
  headerEnv?: { header: string; env: string }[]
  /** Shortcut for plain `Authorization: Bearer <env>` auth on HTTP entries. */
  bearerTokenEnvVar?: string
  /** Description of what the server provides */
  description: string
  /** Category for grouping */
  category: 'tools' | 'data' | 'dev' | 'communication' | 'web' | 'search' | 'productivity' | 'infra' | 'ai'
  /** Required environment variable keys */
  requiredEnvKeys: string[]
  /** Optional environment variable keys */
  optionalEnvKeys?: string[]
  /** Repository/docs URL */
  repo?: string
  /** Whether this is a verified/recommended server */
  verified: boolean
  /**
   * Brand-logo key for the quick-add card (see BrandIcon). Maps to a Simple
   * Icons mark rendered in the brand's official color. Omit for servers with
   * no brand mark — they fall back to a monochrome category glyph.
   */
  iconKey?: string
  /** Interactive auth preflight (OAuth etc.) this server needs before first use. */
  auth?: boolean
  /** Args passed to the server during the auth preflight (e.g. ["auth"]). */
  authArgs?: string[]
  /** File-shaped credentials the server reads/writes (declarations only). */
  credentialFiles?: { path: string; required?: boolean; writeBack?: boolean }[]
  /**
   * What the user must obtain/enable in their own account before this server
   * can work — rendered as a callout on the quick-add card and next to the
   * matching credential-file drop input.
   */
  prerequisite?: string
}

/**
 * Name-squat blocklist — NEVER map an entry to these packages. They squat
 * well-known project names but are unrelated (or hostile) third parties:
 * PyPI `mcp-gmail`, PyPI `telegram-mcp`, PyPI `mcp-server-milvus`,
 * npm `mcp-filesystem-server`, npm `github-mcp-server`.
 */
export const MCP_REGISTRY: McpRegistryEntry[] = [
  // ── Tools ──────────────────────────────────────────────────────────────
  {
    name: 'filesystem',
    displayName: 'Filesystem',
    npmPackage: '@modelcontextprotocol/server-filesystem',
    args: ['{directory}'],
    description: 'Read, write, and manage local files and directories',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem',
    verified: true
  },
  {
    name: 'playwright',
    displayName: 'Playwright Browser',
    npmPackage: '@playwright/mcp',
    description: 'Maintained browser automation that attaches to the agent\'s persistent visible Chromium session',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/microsoft/playwright-mcp',
    verified: true
  },
  {
    name: 'sequential-thinking',
    displayName: 'Sequential Thinking',
    npmPackage: '@modelcontextprotocol/server-sequential-thinking',
    description: 'Dynamic, reflective problem-solving through thought sequences',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    verified: true
  },
  {
    name: 'markitdown',
    displayName: 'MarkItDown',
    pypiPackage: 'markitdown-mcp',
    runtime: 'python',
    description: 'Convert documents (PDF, Office, images, audio) to Markdown',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/microsoft/markitdown',
    verified: true
  },
  {
    name: 'pandoc',
    displayName: 'Pandoc',
    iconKey: 'pandoc',
    pypiPackage: 'mcp-pandoc',
    runtime: 'python',
    description: 'Convert documents between Markdown, HTML, DOCX, PDF, EPUB, and more',
    category: 'tools',
    requiredEnvKeys: [],
    repo: 'https://github.com/vivekVells/mcp-pandoc',
    verified: false,
    prerequisite: 'Needs the pandoc binary installed where the server runs (host run recommended; PDF output additionally needs TeX).'
  },
  // ── Search ─────────────────────────────────────────────────────────────
  {
    name: 'brave-search',
    displayName: 'Brave Search',
    iconKey: 'brave',
    npmPackage: '@brave/brave-search-mcp-server',
    description: 'Search the web using Brave Search API',
    category: 'search',
    requiredEnvKeys: ['BRAVE_API_KEY'],
    repo: 'https://github.com/brave/brave-search-mcp-server',
    verified: true
  },
  {
    name: 'context7',
    displayName: 'Context7',
    npmPackage: '@upstash/context7-mcp',
    description: 'Up-to-date, version-specific library documentation and code examples',
    category: 'search',
    requiredEnvKeys: [],
    repo: 'https://github.com/upstash/context7',
    verified: true
  },
  {
    name: 'tavily',
    displayName: 'Tavily',
    npmPackage: 'tavily-mcp',
    description: 'AI-optimized web search, extract, map, and crawl via the Tavily API',
    category: 'search',
    requiredEnvKeys: ['TAVILY_API_KEY'],
    repo: 'https://github.com/tavily-ai/tavily-mcp',
    verified: true
  },
  {
    name: 'exa',
    displayName: 'Exa',
    npmPackage: 'exa-mcp-server',
    description: 'Neural web search and content retrieval via the Exa API',
    category: 'search',
    requiredEnvKeys: ['EXA_API_KEY'],
    repo: 'https://github.com/exa-labs/exa-mcp-server',
    verified: true
  },
  {
    name: 'perplexity',
    displayName: 'Perplexity',
    iconKey: 'perplexity',
    npmPackage: '@perplexity-ai/mcp-server',
    description: 'Web search, research, and reasoning via the Perplexity Sonar API',
    category: 'search',
    requiredEnvKeys: ['PERPLEXITY_API_KEY'],
    repo: 'https://github.com/perplexityai/modelcontextprotocol',
    verified: true
  },
  {
    name: 'kagi',
    displayName: 'Kagi Search',
    iconKey: 'kagi',
    pypiPackage: 'kagimcp',
    runtime: 'python',
    description: 'Search the web using the Kagi Search API',
    category: 'search',
    requiredEnvKeys: ['KAGI_API_KEY'],
    repo: 'https://github.com/kagisearch/kagi-mcp',
    verified: true,
    prerequisite: 'Needs a Kagi account with Search API access; the server pins Python 3.12.'
  },
  {
    name: 'aws-docs',
    displayName: 'AWS Documentation',
    pypiPackage: 'awslabs.aws-documentation-mcp-server',
    runtime: 'python',
    description: 'Search, read, and get recommendations from AWS documentation',
    category: 'search',
    requiredEnvKeys: [],
    repo: 'https://github.com/awslabs/mcp',
    verified: true
  },
  {
    name: 'deepwiki',
    displayName: 'DeepWiki',
    url: 'https://mcp.deepwiki.com/mcp',
    description: 'Ask questions about any public GitHub repository via DeepWiki',
    category: 'search',
    requiredEnvKeys: [],
    repo: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    verified: true
  },
  {
    name: 'microsoft-learn',
    displayName: 'Microsoft Learn',
    url: 'https://learn.microsoft.com/api/mcp',
    description: 'Search and fetch official Microsoft and Azure documentation and code samples',
    category: 'search',
    requiredEnvKeys: [],
    repo: 'https://github.com/microsoftdocs/mcp',
    verified: true
  },
  {
    name: 'cloudflare-docs',
    displayName: 'Cloudflare Docs',
    iconKey: 'cloudflare',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    description: 'Search Cloudflare developer documentation',
    category: 'search',
    requiredEnvKeys: [],
    repo: 'https://github.com/cloudflare/mcp-server-cloudflare',
    verified: true
  },
  {
    name: 'duckduckgo',
    displayName: 'DuckDuckGo',
    iconKey: 'duckduckgo',
    pypiPackage: 'duckduckgo-mcp-server',
    runtime: 'python',
    description: 'Zero-key web search via DuckDuckGo with built-in client-side rate limiting',
    category: 'search',
    requiredEnvKeys: [],
    repo: 'https://github.com/nickclyde/duckduckgo-mcp-server',
    verified: false
  },
  {
    name: 'serper',
    displayName: 'Serper',
    pypiPackage: 'serper-mcp-server',
    runtime: 'python',
    description: 'Google results (web, images, news, maps, scholar) via the Serper.dev API',
    category: 'search',
    requiredEnvKeys: ['SERPER_API_KEY'],
    repo: 'https://github.com/garylab/serper-mcp-server',
    verified: false
  },
  {
    name: 'searxng',
    displayName: 'SearXNG',
    iconKey: 'searxng',
    npmPackage: 'mcp-searxng',
    description: 'Meta-search through a SearXNG instance, plus URL reading',
    category: 'search',
    requiredEnvKeys: ['SEARXNG_URL'],
    optionalEnvKeys: ['AUTH_USERNAME', 'AUTH_PASSWORD'],
    repo: 'https://github.com/ihor-sokoliuk/mcp-searxng',
    verified: false,
    prerequisite: 'Needs a reachable SearXNG instance with the JSON output format enabled.'
  },
  {
    name: 'arxiv',
    displayName: 'arXiv',
    iconKey: 'arxiv',
    pypiPackage: 'arxiv-mcp-server',
    runtime: 'python',
    description: 'Search, download, and read arXiv papers',
    category: 'search',
    requiredEnvKeys: [],
    repo: 'https://github.com/blazickjp/arxiv-mcp-server',
    verified: false
  },
  // ── Web ────────────────────────────────────────────────────────────────
  {
    name: 'fetch',
    displayName: 'Fetch',
    pypiPackage: 'mcp-server-fetch',
    runtime: 'python',
    description: 'Fetch web pages and convert them to markdown for reading',
    category: 'web',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    verified: true,
    prerequisite: 'Can reach local and internal addresses (SSRF-capable) — the container run location is the safe default.'
  },
  {
    name: 'firecrawl',
    displayName: 'Firecrawl',
    npmPackage: 'firecrawl-mcp',
    description: 'Web scraping, crawling, and structured extraction via the Firecrawl API',
    category: 'web',
    requiredEnvKeys: ['FIRECRAWL_API_KEY'],
    optionalEnvKeys: ['FIRECRAWL_API_URL'],
    repo: 'https://github.com/firecrawl/firecrawl-mcp-server',
    verified: true
  },
  {
    name: 'apify',
    displayName: 'Apify',
    npmPackage: '@apify/actors-mcp-server',
    description: 'Run Apify Actors for web scraping and automation at scale',
    category: 'web',
    requiredEnvKeys: ['APIFY_TOKEN'],
    repo: 'https://github.com/apify/apify-mcp-server',
    verified: true
  },
  {
    name: 'oxylabs',
    displayName: 'Oxylabs',
    pypiPackage: 'oxylabs-mcp',
    runtime: 'python',
    description: 'Proxy-backed web scraping (universal, Google, Amazon) via Oxylabs',
    category: 'web',
    requiredEnvKeys: ['OXYLABS_USERNAME', 'OXYLABS_PASSWORD'],
    repo: 'https://github.com/oxylabs/oxylabs-mcp',
    verified: true,
    prerequisite: 'Needs a paid Oxylabs account with Web Scraper API access.'
  },
  {
    name: 'youtube-transcript',
    displayName: 'YouTube Transcript',
    npmPackage: '@kimtaeyoon83/mcp-server-youtube-transcript',
    description: 'Fetch transcripts and captions for YouTube videos',
    category: 'web',
    requiredEnvKeys: [],
    repo: 'https://github.com/kimtaeyoon83/mcp-server-youtube-transcript',
    verified: false,
    prerequisite: 'YouTube may block datacenter IPs — if transcript fetches fail from a container, run on host.'
  },
  // ── Dev ────────────────────────────────────────────────────────────────
  {
    name: 'github',
    displayName: 'GitHub',
    iconKey: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    bearerTokenEnvVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    description: 'Official GitHub remote server — repositories, issues, pull requests, and actions',
    category: 'dev',
    requiredEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    repo: 'https://github.com/github/github-mcp-server',
    verified: true,
    prerequisite: 'Needs a GitHub personal access token (github.com/settings/tokens) scoped to the repositories it should reach.'
  },
  {
    name: 'git',
    displayName: 'Git',
    pypiPackage: 'mcp-server-git',
    runtime: 'python',
    description: 'Inspect and operate on local Git repositories (repository path is passed per tool call)',
    category: 'dev',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    verified: true
  },
  {
    name: 'sentry',
    displayName: 'Sentry',
    iconKey: 'sentry',
    npmPackage: '@sentry/mcp-server',
    description: 'Query Sentry issues, events, and projects',
    category: 'dev',
    requiredEnvKeys: ['SENTRY_ACCESS_TOKEN'],
    optionalEnvKeys: ['SENTRY_HOST'],
    repo: 'https://github.com/getsentry/sentry-mcp',
    verified: true
  },
  {
    name: 'supabase',
    displayName: 'Supabase',
    iconKey: 'supabase',
    npmPackage: '@supabase/mcp-server-supabase',
    description: 'Manage Supabase projects: database, auth, storage, and edge functions',
    category: 'dev',
    requiredEnvKeys: ['SUPABASE_ACCESS_TOKEN'],
    repo: 'https://github.com/supabase-community/supabase-mcp',
    verified: true
  },
  {
    name: 'semgrep',
    displayName: 'Semgrep',
    pypiPackage: 'semgrep-mcp',
    runtime: 'python',
    description: 'Static-analysis security scanning of code with Semgrep',
    category: 'dev',
    requiredEnvKeys: [],
    repo: 'https://github.com/semgrep/mcp',
    verified: true
  },
  {
    name: 'chrome-devtools',
    displayName: 'Chrome DevTools',
    iconKey: 'chrome',
    npmPackage: 'chrome-devtools-mcp',
    description: 'Drive and debug Chrome via the DevTools protocol — performance traces, network, console',
    category: 'dev',
    requiredEnvKeys: [],
    repo: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    verified: true,
    prerequisite: 'Drives a local Chrome installation — run on host with Chrome installed.'
  },
  {
    name: 'shopify-dev',
    displayName: 'Shopify Dev',
    iconKey: 'shopify',
    npmPackage: '@shopify/dev-mcp',
    description: 'Shopify developer docs and API schema exploration (zero-config, docs only)',
    category: 'dev',
    requiredEnvKeys: [],
    repo: 'https://github.com/Shopify/dev-mcp',
    verified: true
  },
  {
    name: 'gitlab',
    displayName: 'GitLab',
    iconKey: 'gitlab',
    npmPackage: '@zereight/mcp-gitlab',
    description: 'GitLab projects, issues, merge requests, pipelines, and wikis',
    category: 'dev',
    requiredEnvKeys: ['GITLAB_API_URL', 'GITLAB_PERSONAL_ACCESS_TOKEN'],
    optionalEnvKeys: ['GITLAB_PERMISSION_MODE'],
    repo: 'https://github.com/zereight/gitlab-mcp',
    verified: false,
    prerequisite: 'Set GITLAB_API_URL to your instance API base (https://gitlab.com/api/v4 for gitlab.com) and use a personal access token.'
  },
  {
    name: 'n8n',
    displayName: 'n8n',
    iconKey: 'n8n',
    npmPackage: 'n8n-mcp',
    description: 'n8n node documentation, workflow building, and optional workflow management',
    category: 'dev',
    requiredEnvKeys: [],
    optionalEnvKeys: ['N8N_API_URL', 'N8N_API_KEY'],
    repo: 'https://github.com/czlonkowski/n8n-mcp',
    verified: false,
    prerequisite: 'Documentation tools work with no configuration; managing workflows needs your n8n instance URL and API key.'
  },
  // ── Data ───────────────────────────────────────────────────────────────
  {
    name: 'memory',
    displayName: 'Memory',
    npmPackage: '@modelcontextprotocol/server-memory',
    description: 'Persistent knowledge graph memory for agents',
    category: 'data',
    requiredEnvKeys: [],
    repo: 'https://github.com/modelcontextprotocol/servers/blob/main/src/memory',
    verified: true
  },
  {
    name: 'mongodb',
    displayName: 'MongoDB',
    iconKey: 'mongodb',
    npmPackage: 'mongodb-mcp-server',
    description: 'Query and manage MongoDB databases and Atlas clusters',
    category: 'data',
    requiredEnvKeys: ['MDB_MCP_CONNECTION_STRING'],
    repo: 'https://github.com/mongodb-js/mongodb-mcp-server',
    verified: true
  },
  {
    name: 'redis',
    displayName: 'Redis',
    iconKey: 'redis',
    pypiPackage: 'redis-mcp-server',
    runtime: 'python',
    description: 'Query and manage Redis data structures',
    category: 'data',
    requiredEnvKeys: ['REDIS_URL'],
    optionalEnvKeys: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PWD'],
    repo: 'https://github.com/redis/mcp-redis',
    verified: true
  },
  {
    name: 'clickhouse',
    displayName: 'ClickHouse',
    iconKey: 'clickhouse',
    pypiPackage: 'mcp-clickhouse',
    runtime: 'python',
    description: 'Run queries against ClickHouse (writes gated off by default)',
    category: 'data',
    requiredEnvKeys: ['CLICKHOUSE_HOST', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD'],
    optionalEnvKeys: ['CLICKHOUSE_PORT', 'CLICKHOUSE_SECURE', 'CLICKHOUSE_DATABASE'],
    repo: 'https://github.com/ClickHouse/mcp-clickhouse',
    verified: true
  },
  {
    name: 'duckdb',
    displayName: 'DuckDB / MotherDuck',
    iconKey: 'duckdb',
    pypiPackage: 'mcp-server-motherduck',
    runtime: 'python',
    args: ['--db-path', '{database-path}'],
    description: 'Query local DuckDB files or MotherDuck cloud databases (read-only by default)',
    category: 'data',
    requiredEnvKeys: [],
    optionalEnvKeys: ['MOTHERDUCK_TOKEN'],
    repo: 'https://github.com/motherduckdb/mcp-server-motherduck',
    verified: true,
    prerequisite: 'Database path can be a local .duckdb file or :memory:; MOTHERDUCK_TOKEN is only needed for MotherDuck cloud.'
  },
  {
    name: 'dbhub',
    displayName: 'DBHub',
    npmPackage: '@bytebase/dbhub',
    description: 'Universal database gateway: SQLite, PostgreSQL, MySQL, MariaDB, and SQL Server',
    category: 'data',
    // DSN via env (not `--dsn {placeholder}`): connection strings usually embed
    // a password, and argv is world-readable — the env path keeps it in
    // credential storage. dbhub precedence: --dsn flag > DSN env > .env file.
    requiredEnvKeys: ['DSN'],
    repo: 'https://github.com/bytebase/dbhub',
    verified: true,
    prerequisite: 'Set DSN to the database connection string (e.g. postgres://user:pass@host/db); requires Node 22.5+.'
  },
  {
    name: 'chroma',
    displayName: 'Chroma',
    pypiPackage: 'chroma-mcp',
    runtime: 'python',
    description: 'Vector search and collections on Chroma (ephemeral mode is zero-config)',
    category: 'data',
    requiredEnvKeys: [],
    optionalEnvKeys: ['CHROMA_CLIENT_TYPE', 'CHROMA_DATA_DIR', 'CHROMA_API_KEY', 'CHROMA_TENANT', 'CHROMA_DATABASE'],
    repo: 'https://github.com/chroma-core/chroma-mcp',
    verified: true
  },
  {
    name: 'qdrant',
    displayName: 'Qdrant',
    iconKey: 'qdrant',
    pypiPackage: 'mcp-server-qdrant',
    runtime: 'python',
    description: 'Semantic memory on Qdrant with built-in local embeddings (fastembed)',
    category: 'data',
    requiredEnvKeys: ['QDRANT_URL', 'COLLECTION_NAME'],
    optionalEnvKeys: ['QDRANT_API_KEY'],
    repo: 'https://github.com/qdrant/mcp-server-qdrant',
    verified: true
  },
  {
    name: 'pinecone',
    displayName: 'Pinecone',
    npmPackage: '@pinecone-database/mcp',
    description: 'Search and manage Pinecone vector indexes',
    category: 'data',
    requiredEnvKeys: ['PINECONE_API_KEY'],
    repo: 'https://github.com/pinecone-io/pinecone-mcp',
    verified: true
  },
  {
    name: 'dbt',
    displayName: 'dbt',
    pypiPackage: 'dbt-mcp',
    runtime: 'python',
    description: 'dbt platform: semantic layer, discovery, and dbt CLI operations',
    category: 'data',
    requiredEnvKeys: ['DBT_HOST', 'DBT_TOKEN', 'DBT_PROD_ENV_ID'],
    optionalEnvKeys: ['DBT_ACCOUNT_ID', 'DBT_DEV_ENV_ID', 'DBT_USER_ID'],
    repo: 'https://github.com/dbt-labs/dbt-mcp',
    verified: true
  },
  {
    name: 'neon',
    displayName: 'Neon',
    url: 'https://mcp.neon.tech/mcp',
    bearerTokenEnvVar: 'NEON_API_KEY',
    description: 'Manage Neon serverless Postgres projects, branches, and queries',
    category: 'data',
    requiredEnvKeys: ['NEON_API_KEY'],
    repo: 'https://github.com/neondatabase/mcp-server-neon',
    verified: true
  },
  {
    name: 'postgres',
    displayName: 'PostgreSQL',
    iconKey: 'postgresql',
    pypiPackage: 'postgres-mcp',
    runtime: 'python',
    description: 'Postgres queries, schema intelligence, index tuning, and health checks',
    category: 'data',
    requiredEnvKeys: ['DATABASE_URI'],
    repo: 'https://github.com/crystaldba/postgres-mcp',
    verified: false
  },
  {
    name: 'mysql',
    displayName: 'MySQL',
    iconKey: 'mysql',
    npmPackage: '@benborla29/mcp-server-mysql',
    description: 'Query MySQL databases (read-only by default, writes gated per-operation)',
    category: 'data',
    requiredEnvKeys: ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASS', 'MYSQL_DB'],
    optionalEnvKeys: ['ALLOW_INSERT_OPERATION', 'ALLOW_UPDATE_OPERATION', 'ALLOW_DELETE_OPERATION'],
    repo: 'https://github.com/benborla/mcp-server-mysql',
    verified: false
  },
  {
    name: 'sqlite',
    displayName: 'SQLite',
    iconKey: 'sqlite',
    npmPackage: 'mcp-sqlite',
    args: ['{database-path}'],
    description: 'Query and manage a local SQLite database file',
    category: 'data',
    requiredEnvKeys: [],
    repo: 'https://github.com/jparkerweb/mcp-sqlite',
    verified: false
  },
  {
    name: 'airtable',
    displayName: 'Airtable',
    iconKey: 'airtable',
    npmPackage: 'airtable-mcp-server',
    description: 'Read and write Airtable bases, tables, and records',
    category: 'data',
    requiredEnvKeys: ['AIRTABLE_API_KEY'],
    repo: 'https://github.com/domdomegg/airtable-mcp-server',
    verified: false,
    prerequisite: 'AIRTABLE_API_KEY is an Airtable personal access token from airtable.com/create/tokens (schema + records scopes).'
  },
  {
    name: 'google-sheets',
    displayName: 'Google Sheets',
    iconKey: 'google-sheets',
    pypiPackage: 'mcp-google-sheets',
    runtime: 'python',
    description: 'Read and write Google Sheets spreadsheets',
    category: 'data',
    requiredEnvKeys: ['SERVICE_ACCOUNT_PATH', 'DRIVE_FOLDER_ID'],
    repo: 'https://github.com/xing5/mcp-google-sheets',
    verified: false,
    prerequisite: 'Headless service-account mode: needs a Google Cloud service-account JSON key (Sheets + Drive APIs enabled) and a Drive folder shared with the service account\'s email. SERVICE_ACCOUNT_PATH points at the key file.'
  },
  {
    name: 'excel',
    displayName: 'Excel',
    pypiPackage: 'excel-mcp-server',
    runtime: 'python',
    args: ['stdio'],
    description: 'Create, read, and edit Excel workbooks without Excel installed',
    category: 'data',
    requiredEnvKeys: [],
    repo: 'https://github.com/haris-musa/excel-mcp-server',
    verified: false
  },
  {
    name: 'google-drive',
    displayName: 'Google Drive',
    iconKey: 'google-drive',
    npmPackage: '@piotr-agier/google-drive-mcp',
    description: 'Read, search, and manage Google Drive, Docs, Sheets, and Slides',
    category: 'data',
    requiredEnvKeys: [],
    repo: 'https://github.com/piotr-agier/google-drive-mcp',
    verified: false,
    auth: true,
    authArgs: ['auth'],
    credentialFiles: [
      { path: '~/.config/google-drive-mcp/gcp-oauth.keys.json', required: true },
      { path: '~/.config/google-drive-mcp/tokens.json' },
    ],
    prerequisite: 'Needs a Google OAuth client JSON (Desktop app) from console.cloud.google.com with the Drive, Docs, Sheets, and Slides APIs enabled.'
  },
  // ── Communication ──────────────────────────────────────────────────────
  {
    name: 'resend',
    displayName: 'Resend',
    npmPackage: 'resend-mcp',
    description: 'Send emails, manage contacts, and broadcasts via the Resend platform',
    category: 'communication',
    requiredEnvKeys: ['RESEND_API_KEY'],
    optionalEnvKeys: ['SENDER_EMAIL_ADDRESS', 'REPLY_TO_EMAIL_ADDRESSES'],
    repo: 'https://github.com/resend/resend-mcp',
    verified: true
  },
  {
    name: 'slack',
    displayName: 'Slack',
    npmPackage: '@zencoderai/slack-mcp-server',
    description: 'Interact with Slack workspaces via a bot token',
    category: 'communication',
    requiredEnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    optionalEnvKeys: ['SLACK_CHANNEL_IDS'],
    repo: 'https://github.com/zencoderai/slack-mcp-server',
    verified: false,
    prerequisite: 'Needs a Slack app (api.slack.com/apps) with bot scopes channels:history, channels:read, chat:write, reactions:write, users:read.'
  },
  {
    name: 'email',
    displayName: 'Email (IMAP/SMTP)',
    npmPackage: '@codefuturist/email-mcp',
    description: 'Search, read, and send email over IMAP and SMTP',
    category: 'communication',
    requiredEnvKeys: ['MCP_EMAIL_ADDRESS', 'MCP_EMAIL_PASSWORD', 'MCP_EMAIL_IMAP_HOST', 'MCP_EMAIL_SMTP_HOST'],
    optionalEnvKeys: ['MCP_EMAIL_IMAP_PORT', 'MCP_EMAIL_SMTP_PORT', 'MCP_EMAIL_IMAP_TLS', 'MCP_EMAIL_SMTP_TLS', 'MCP_EMAIL_SMTP_STARTTLS'],
    repo: 'https://github.com/codefuturist/email-mcp',
    verified: false,
    prerequisite: 'Use an app password for providers with 2FA (e.g. Gmail); requires Node 22+.'
  },
  {
    name: 'telegram',
    displayName: 'Telegram',
    iconKey: 'telegram',
    npmPackage: '@iqai/mcp-telegram',
    description: 'Interact with Telegram via bot API for messaging and channel management',
    category: 'communication',
    requiredEnvKeys: ['TELEGRAM_BOT_TOKEN'],
    repo: 'https://github.com/IQAIcom/mcp-telegram',
    verified: false
  },
  {
    name: 'discord',
    displayName: 'Discord',
    iconKey: 'discord',
    npmPackage: 'mcp-discord',
    description: 'Discord bot integration for messages, channels, forums, and webhooks',
    category: 'communication',
    requiredEnvKeys: ['DISCORD_TOKEN'],
    repo: 'https://github.com/barryyip0625/mcp-discord',
    verified: false
  },
  {
    name: 'gmail',
    displayName: 'Gmail',
    iconKey: 'gmail',
    npmPackage: '@gongrzhe/server-gmail-autoauth-mcp',
    description: 'Search, read, label, and send Gmail',
    category: 'communication',
    requiredEnvKeys: [],
    repo: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    verified: false,
    auth: true,
    authArgs: ['auth'],
    credentialFiles: [
      { path: '~/.gmail-mcp/gcp-oauth.keys.json', required: true },
      { path: '~/.gmail-mcp/credentials.json' },
    ],
    prerequisite: 'Needs a Google OAuth client JSON (Desktop app) from console.cloud.google.com with the Gmail API enabled. Upstream repo was archived in 2025 but this remains the most-used Gmail server.'
  },
  {
    name: 'twilio',
    displayName: 'Twilio SMS',
    npmPackage: '@deshartman/twilio-messaging-mcp-server',
    description: 'Send and receive SMS messages via the Twilio Messaging API',
    category: 'communication',
    requiredEnvKeys: ['NGROK_AUTH_TOKEN', 'ACCOUNT_SID', 'API_KEY', 'API_SECRET', 'TWILIO_NUMBER'],
    optionalEnvKeys: ['NGROK_CUSTOM_DOMAIN'],
    repo: 'https://github.com/deshartman/twilio-messaging-mcp-server',
    verified: false
  },
  {
    name: 'teams',
    displayName: 'Microsoft Teams',
    npmPackage: '@floriscornel/teams-mcp',
    description: 'Read and send Microsoft Teams channel and chat messages as the signed-in user',
    category: 'communication',
    requiredEnvKeys: [],
    repo: 'https://github.com/floriscornel/teams-mcp',
    verified: false,
    auth: true,
    authArgs: ['authenticate'],
    credentialFiles: [
      { path: '~/.teams-mcp-token-cache.json' },
      { path: '~/.msgraph-mcp-auth.json' },
    ],
    prerequisite: 'Signs into Microsoft 365 with a device code on first auth — no Azure app registration needed (some tenants require admin consent for the shared client).'
  },
  // ── Productivity ───────────────────────────────────────────────────────
  {
    name: 'notion',
    displayName: 'Notion',
    iconKey: 'notion',
    npmPackage: '@notionhq/notion-mcp-server',
    description: 'Search, read, and write Notion pages and databases',
    category: 'productivity',
    requiredEnvKeys: ['NOTION_TOKEN'],
    repo: 'https://github.com/makenotion/notion-mcp-server',
    verified: true,
    prerequisite: 'Needs an internal integration token (notion.so/profile/integrations); share the target pages with the integration.'
  },
  {
    name: 'linear',
    displayName: 'Linear',
    iconKey: 'linear',
    url: 'https://mcp.linear.app/mcp',
    bearerTokenEnvVar: 'LINEAR_API_KEY',
    description: 'Official Linear remote server — issues, projects, and cycles',
    category: 'productivity',
    requiredEnvKeys: ['LINEAR_API_KEY'],
    repo: 'https://linear.app/docs/mcp',
    verified: true,
    prerequisite: 'Needs a Linear personal API key (Settings > Security & access > Personal API keys).'
  },
  {
    name: 'atlassian-cloud',
    displayName: 'Atlassian Cloud',
    iconKey: 'atlassian',
    url: 'https://mcp.atlassian.com/v1/mcp',
    bearerTokenEnvVar: 'ATLASSIAN_API_KEY',
    description: 'Official Atlassian remote server — Jira, Confluence, JSM, Bitbucket, and Compass',
    category: 'productivity',
    requiredEnvKeys: ['ATLASSIAN_API_KEY'],
    repo: 'https://github.com/atlassian/atlassian-mcp-server',
    verified: true,
    prerequisite: 'Needs a service-account API key, and an org admin must enable API-token access to the MCP server. Atlassian Cloud only.'
  },
  {
    name: 'todoist',
    displayName: 'Todoist',
    iconKey: 'todoist',
    npmPackage: '@doist/todoist-mcp',
    description: 'Manage Todoist tasks, projects, and labels',
    category: 'productivity',
    requiredEnvKeys: ['TODOIST_API_KEY'],
    repo: 'https://github.com/Doist/todoist-mcp',
    verified: true,
    prerequisite: 'API key from Todoist Settings > Integrations > Developer.'
  },
  {
    name: 'monday',
    displayName: 'monday.com',
    npmPackage: '@mondaydotcomorg/monday-api-mcp',
    description: 'Manage monday.com boards, items, and workflows',
    category: 'productivity',
    requiredEnvKeys: ['monday_token'],
    repo: 'https://github.com/mondaycom/monday-ai',
    verified: true
  },
  {
    name: 'cal-com',
    displayName: 'Cal.com',
    iconKey: 'cal-com',
    npmPackage: '@calcom/cal-mcp',
    description: 'Manage Cal.com bookings and event types',
    category: 'productivity',
    requiredEnvKeys: ['CAL_API_KEY'],
    repo: 'https://github.com/calcom/cal-mcp',
    verified: true
  },
  {
    name: 'stripe',
    displayName: 'Stripe',
    iconKey: 'stripe',
    npmPackage: '@stripe/mcp',
    description: 'Query and manage Stripe payments, customers, and subscriptions',
    category: 'productivity',
    requiredEnvKeys: ['STRIPE_SECRET_KEY'],
    repo: 'https://github.com/stripe/ai',
    verified: true,
    prerequisite: 'A restricted API key (dashboard.stripe.com/apikeys) scoped to just the resources the agent needs is strongly recommended.'
  },
  {
    name: 'paypal',
    displayName: 'PayPal',
    iconKey: 'paypal',
    npmPackage: '@paypal/mcp',
    description: 'Manage PayPal invoices, orders, and subscriptions',
    category: 'productivity',
    requiredEnvKeys: ['PAYPAL_ACCESS_TOKEN', 'PAYPAL_ENVIRONMENT'],
    repo: 'https://github.com/paypal/agent-toolkit',
    verified: true,
    prerequisite: 'Generate an access token from your PayPal developer client ID + secret; set PAYPAL_ENVIRONMENT to SANDBOX or PRODUCTION.'
  },
  {
    name: 'hubspot',
    displayName: 'HubSpot',
    iconKey: 'hubspot',
    npmPackage: '@hubspot/mcp-server',
    description: 'Query and manage HubSpot CRM objects and associations',
    category: 'productivity',
    requiredEnvKeys: ['PRIVATE_APP_ACCESS_TOKEN'],
    repo: 'https://developers.hubspot.com/mcp',
    verified: true,
    prerequisite: 'Needs a HubSpot private-app access token (Settings > Integrations > Private Apps). Beta.'
  },
  {
    name: 'zapier',
    displayName: 'Zapier',
    iconKey: 'zapier',
    url: 'https://mcp.zapier.com/api/v1/connect',
    bearerTokenEnvVar: 'ZAPIER_MCP_TOKEN',
    description: 'Run actions across 8000+ apps through your Zapier MCP server',
    category: 'productivity',
    requiredEnvKeys: ['ZAPIER_MCP_TOKEN'],
    repo: 'https://zapier.com/mcp',
    verified: true,
    prerequisite: 'Create an MCP server and pick its tools at mcp.zapier.com first; use the token from its Connect tab.'
  },
  {
    name: 'atlassian',
    displayName: 'Atlassian (self-host)',
    iconKey: 'atlassian',
    pypiPackage: 'mcp-atlassian',
    runtime: 'python',
    description: 'Jira and Confluence — Cloud, Server, and Data Center',
    category: 'productivity',
    requiredEnvKeys: [],
    optionalEnvKeys: ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_PERSONAL_TOKEN', 'CONFLUENCE_URL', 'CONFLUENCE_USERNAME', 'CONFLUENCE_API_TOKEN'],
    repo: 'https://github.com/sooperset/mcp-atlassian',
    verified: false,
    prerequisite: 'Set the JIRA_* and/or CONFLUENCE_* trio for the products you use (Cloud: URL + username + API token; Server/DC: URL + personal access token).'
  },
  {
    name: 'trello',
    displayName: 'Trello',
    iconKey: 'trello',
    npmPackage: '@delorenj/mcp-server-trello',
    description: 'Manage Trello boards, lists, and cards',
    category: 'productivity',
    requiredEnvKeys: ['TRELLO_API_KEY', 'TRELLO_TOKEN'],
    optionalEnvKeys: ['TRELLO_WORKSPACE_ID'],
    repo: 'https://github.com/delorenj/mcp-server-trello',
    verified: false,
    prerequisite: 'API key and token from trello.com/app-key.'
  },
  {
    name: 'google-calendar',
    displayName: 'Google Calendar',
    iconKey: 'google-calendar',
    npmPackage: '@cocal/google-calendar-mcp',
    description: 'Read, create, and manage Google Calendar events',
    category: 'productivity',
    requiredEnvKeys: ['GOOGLE_OAUTH_CREDENTIALS'],
    repo: 'https://github.com/nspady/google-calendar-mcp',
    verified: false,
    auth: true,
    authArgs: ['auth'],
    credentialFiles: [
      { path: '~/.config/google-calendar-mcp/gcp-oauth.keys.json', required: true },
      { path: '~/.config/google-calendar-mcp/tokens.json' },
    ],
    prerequisite: 'Needs a Google OAuth client JSON (Desktop app) with the Calendar API enabled. GOOGLE_OAUTH_CREDENTIALS is the key file PATH (e.g. ~/.config/google-calendar-mcp/gcp-oauth.keys.json), not a token.'
  },
  {
    name: 'google-docs',
    displayName: 'Google Docs',
    iconKey: 'google-docs',
    npmPackage: '@a-bonus/google-docs-mcp',
    description: 'Read and edit Google Docs, Sheets, and Drive files',
    category: 'productivity',
    requiredEnvKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    repo: 'https://github.com/a-bonus/google-docs-mcp',
    verified: false,
    auth: true,
    authArgs: ['auth'],
    credentialFiles: [
      { path: '~/.config/google-docs-mcp/token.json' },
    ],
    prerequisite: 'Needs a Google OAuth client (ID + secret) from console.cloud.google.com with the Docs, Sheets, and Drive APIs enabled.'
  },
  {
    name: 'workspace',
    displayName: 'Google Workspace',
    pypiPackage: 'workspace-mcp',
    runtime: 'python',
    description: 'All-in-one Google Workspace: Gmail, Drive, Calendar, Docs, Sheets, Slides, and more (120+ tools)',
    category: 'productivity',
    requiredEnvKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    repo: 'https://github.com/taylorwilsdon/google_workspace_mcp',
    verified: false,
    prerequisite: 'Needs a Google OAuth client from console.cloud.google.com with each Workspace API enabled. Browser sign-in happens in-flow on first use (port 8000) — host run recommended.'
  },
  {
    name: 'raindrop',
    displayName: 'Raindrop.io',
    npmPackage: '@adeze/raindrop-mcp',
    description: 'Manage Raindrop.io bookmarks, collections, and tags',
    category: 'productivity',
    requiredEnvKeys: ['RAINDROP_ACCESS_TOKEN'],
    repo: 'https://github.com/adeze/raindrop-mcp',
    verified: false,
    prerequisite: 'Test token from app.raindrop.io/settings/integrations (create an app, then "Test token").'
  },
  // ── Infra ──────────────────────────────────────────────────────────────
  {
    name: 'grafana',
    displayName: 'Grafana',
    iconKey: 'grafana',
    pypiPackage: 'mcp-grafana',
    runtime: 'python',
    description: 'Query Grafana dashboards, datasources, alerts, and incidents',
    category: 'infra',
    requiredEnvKeys: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'],
    repo: 'https://github.com/grafana/mcp-grafana',
    verified: true,
    prerequisite: 'Needs a reachable Grafana 9.0+ instance and a service-account token.'
  },
  {
    name: 'pagerduty',
    displayName: 'PagerDuty',
    iconKey: 'pagerduty',
    pypiPackage: 'pagerduty-mcp',
    runtime: 'python',
    description: 'Query PagerDuty incidents, services, and on-call schedules (writes off by default)',
    category: 'infra',
    requiredEnvKeys: ['PAGERDUTY_USER_API_KEY'],
    repo: 'https://github.com/PagerDuty/pagerduty-mcp-server',
    verified: true
  },
  {
    name: 'netlify',
    displayName: 'Netlify',
    iconKey: 'netlify',
    npmPackage: '@netlify/mcp',
    description: 'Create, build, deploy, and manage Netlify projects',
    category: 'infra',
    requiredEnvKeys: [],
    optionalEnvKeys: ['NETLIFY_PERSONAL_ACCESS_TOKEN'],
    repo: 'https://github.com/netlify/netlify-mcp',
    verified: true,
    prerequisite: 'Reuses Netlify CLI login state — run `netlify login` on host first (or set NETLIFY_PERSONAL_ACCESS_TOKEN). Requires Node 22+.'
  },
  {
    name: 'cloudflare-bindings',
    displayName: 'Cloudflare Bindings',
    iconKey: 'cloudflare',
    url: 'https://bindings.mcp.cloudflare.com/mcp',
    bearerTokenEnvVar: 'CLOUDFLARE_API_TOKEN',
    description: 'Build with Cloudflare Workers: KV, R2, D1, and Durable Objects',
    category: 'infra',
    requiredEnvKeys: ['CLOUDFLARE_API_TOKEN'],
    repo: 'https://github.com/cloudflare/mcp-server-cloudflare',
    verified: true,
    prerequisite: 'Needs a Cloudflare API token scoped for Workers resources.'
  },
  {
    name: 'cloudflare-observability',
    displayName: 'Cloudflare Observability',
    iconKey: 'cloudflare',
    url: 'https://observability.mcp.cloudflare.com/mcp',
    bearerTokenEnvVar: 'CLOUDFLARE_API_TOKEN',
    description: 'Debug Cloudflare Workers: logs, analytics, and errors',
    category: 'infra',
    requiredEnvKeys: ['CLOUDFLARE_API_TOKEN'],
    repo: 'https://github.com/cloudflare/mcp-server-cloudflare',
    verified: true,
    prerequisite: 'Needs a Cloudflare API token with Workers observability scopes.'
  },
  {
    name: 'datadog',
    displayName: 'Datadog',
    url: 'https://mcp.datadoghq.com/v1/mcp',
    headerEnv: [
      { header: 'DD-API-KEY', env: 'DD_API_KEY' },
      { header: 'DD-APPLICATION-KEY', env: 'DD_APPLICATION_KEY' },
    ],
    description: 'Query Datadog monitors, dashboards, metrics, and incidents',
    category: 'infra',
    requiredEnvKeys: ['DD_API_KEY', 'DD_APPLICATION_KEY'],
    repo: 'https://docs.datadoghq.com/mcp_server/',
    verified: true,
    prerequisite: 'US1 endpoint — swap the host for your region (e.g. mcp.datadoghq.eu). Needs a Datadog API key and application key.'
  },
  {
    name: 'prometheus',
    displayName: 'Prometheus',
    iconKey: 'prometheus',
    pypiPackage: 'prometheus-mcp-server',
    runtime: 'python',
    description: 'Run PromQL queries and explore Prometheus metrics',
    category: 'infra',
    requiredEnvKeys: ['PROMETHEUS_URL'],
    repo: 'https://github.com/pab1it0/prometheus-mcp-server',
    verified: false,
    prerequisite: 'Needs a reachable Prometheus server.'
  },
  {
    name: 'kubernetes',
    displayName: 'Kubernetes',
    iconKey: 'kubernetes',
    npmPackage: 'kubernetes-mcp-server',
    description: 'Inspect and manage Kubernetes clusters via the native API (no kubectl needed)',
    category: 'infra',
    requiredEnvKeys: [],
    optionalEnvKeys: ['KUBECONFIG'],
    repo: 'https://github.com/containers/kubernetes-mcp-server',
    verified: false,
    prerequisite: 'Needs a kubeconfig on the machine it runs on — host run recommended.'
  },
  {
    name: 'docker',
    displayName: 'Docker',
    iconKey: 'docker',
    pypiPackage: 'mcp-server-docker',
    runtime: 'python',
    description: 'Manage Docker containers, images, volumes, and networks',
    category: 'infra',
    requiredEnvKeys: [],
    optionalEnvKeys: ['DOCKER_HOST'],
    repo: 'https://github.com/ckreiling/mcp-server-docker',
    verified: false,
    prerequisite: 'Needs access to a Docker daemon — host run recommended (DOCKER_HOST supports ssh:// remotes).'
  },
  // ── AI / creative ──────────────────────────────────────────────────────
  {
    name: 'elevenlabs',
    displayName: 'ElevenLabs',
    iconKey: 'elevenlabs',
    pypiPackage: 'elevenlabs-mcp',
    runtime: 'python',
    description: 'Text-to-speech, voice cloning, and audio generation via ElevenLabs',
    category: 'ai',
    requiredEnvKeys: ['ELEVENLABS_API_KEY'],
    optionalEnvKeys: ['ELEVENLABS_MCP_BASE_PATH', 'ELEVENLABS_MCP_OUTPUT_MODE'],
    repo: 'https://github.com/elevenlabs/elevenlabs-mcp',
    verified: true
  },
  {
    name: 'antv-chart',
    displayName: 'AntV Chart',
    npmPackage: '@antv/mcp-server-chart',
    description: 'Generate 25+ chart types as images via AntV',
    category: 'ai',
    requiredEnvKeys: [],
    repo: 'https://github.com/antvis/mcp-server-chart',
    verified: true
  },
  {
    name: 'browserbase',
    displayName: 'Browserbase',
    npmPackage: '@browserbasehq/mcp',
    description: 'Cloud browser automation with Stagehand — act, extract, and observe on any site',
    category: 'ai',
    requiredEnvKeys: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY'],
    repo: 'https://github.com/browserbase/mcp-server-browserbase',
    verified: true,
    prerequisite: 'Needs a Browserbase API key + project ID, plus a Gemini API key for the default Stagehand model.'
  },
  {
    name: 'huggingface',
    displayName: 'Hugging Face',
    iconKey: 'huggingface',
    url: 'https://huggingface.co/mcp',
    bearerTokenEnvVar: 'HF_TOKEN',
    description: 'Search Hugging Face models, datasets, papers, and Spaces',
    category: 'ai',
    requiredEnvKeys: ['HF_TOKEN'],
    repo: 'https://github.com/huggingface/hf-mcp-server',
    verified: true,
    prerequisite: 'Needs a Hugging Face access token (huggingface.co/settings/tokens, Read scope).'
  },
  {
    name: 'mermaid',
    displayName: 'Mermaid',
    iconKey: 'mermaid',
    npmPackage: 'mcp-mermaid',
    description: 'Generate and render Mermaid diagrams',
    category: 'ai',
    requiredEnvKeys: [],
    repo: 'https://github.com/hustcc/mcp-mermaid',
    verified: false
  },
  {
    name: 'blender',
    displayName: 'Blender',
    iconKey: 'blender',
    pypiPackage: 'blender-mcp',
    runtime: 'python',
    description: 'Control Blender for 3D modeling and scene creation',
    category: 'ai',
    requiredEnvKeys: [],
    repo: 'https://github.com/ahujasid/blender-mcp',
    verified: false,
    prerequisite: 'Install the Blender MCP addon and click "Start MCP Server" inside Blender first; connects to localhost:9876 — host run required.'
  }
]

/**
 * Matches a `{placeholder-name}` token in a registry `args` entry — a value
 * the user must fill in before install. Placeholders are never secrets
 * (argv is world-readable on the host).
 */
export const REGISTRY_ARG_PLACEHOLDER_RE = /\{[a-z0-9-]+\}/

/**
 * Whether any arg still carries an unresolved `{placeholder}` token — the
 * Add-server modal gates Connect/Save on this until the user fills them in.
 */
export function hasUnresolvedPlaceholderArgs(args: string[] | undefined): boolean {
  return (args ?? []).some((arg) => REGISTRY_ARG_PLACEHOLDER_RE.test(arg))
}

/**
 * Build a Settings registration draft from a curated entry. User-initiated
 * Settings installs default to host (the explicit choice is the trust
 * decision; no Podman required) — shared by the Add-server modal and tests.
 *
 * HTTP entries (`url` present) become remote registrations: no runLocation,
 * no managed flag, no auth/credentialFiles. Their `env` is seeded with one
 * empty-value row per unique env key (required/optional/bearer/headerEnv) so
 * the modal shows a value input for each credential the endpoint needs.
 */
export function registrationFromRegistryEntry(entry: McpRegistryEntry, id: string): import('../types/ipc.types').McpServerRegistration {
  if (entry.url) {
    const envKeys = [...new Set([
      ...entry.requiredEnvKeys,
      ...(entry.optionalEnvKeys ?? []),
      ...(entry.bearerTokenEnvVar ? [entry.bearerTokenEnvVar] : []),
      ...(entry.headerEnv ?? []).map(({ env }) => env),
    ])]
    return {
      id,
      name: entry.name,
      type: 'http',
      url: entry.url,
      description: entry.description,
      repo: entry.repo,
      env: envKeys.map((k) => ({ key: k, value: '' })),
      ...(entry.bearerTokenEnvVar ? { bearerTokenEnvVar: entry.bearerTokenEnvVar } : {}),
      // Registration headerEnv rows are { key: headerName, value: envVarName }.
      ...(entry.headerEnv?.length ? { headerEnv: entry.headerEnv.map(({ header, env }) => ({ key: header, value: env })) } : {}),
    }
  }
  const isPython = entry.runtime === 'python'
  return {
    id,
    name: entry.name,
    type: isPython ? 'uvx' : 'npm',
    npmPackage: isPython ? undefined : entry.npmPackage,
    pypiPackage: isPython ? entry.pypiPackage : undefined,
    description: entry.description,
    managed: true,
    env: [...entry.requiredEnvKeys, ...(entry.optionalEnvKeys ?? [])].map((k) => ({ key: k, value: '' })),
    repo: entry.repo,
    runLocation: 'host',
    // Placeholders are copied verbatim — the modal resolves them before install.
    ...(entry.args?.length ? { args: [...entry.args] } : {}),
    ...(entry.auth ? { auth: true } : {}),
    ...(entry.authArgs ? { authArgs: entry.authArgs } : {}),
    ...(entry.credentialFiles ? { credentialFiles: entry.credentialFiles.map((f) => ({ ...f })) } : {}),
  }
}

/**
 * Look up a registry entry by npm package name.
 */
export function findRegistryEntry(npmPackage: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.npmPackage === npmPackage)
}

/**
 * Look up a registry entry by PyPI package name.
 */
export function findRegistryEntryByPypiPackage(pypiPackage: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.pypiPackage === pypiPackage)
}

/**
 * Look up a registry entry by short name.
 */
export function findRegistryEntryByName(name: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.name === name)
}

/**
 * Look up a remote registry entry by Streamable HTTP endpoint URL.
 */
export function findRegistryEntryByUrl(url: string): McpRegistryEntry | undefined {
  return MCP_REGISTRY.find((e) => e.url === url)
}
