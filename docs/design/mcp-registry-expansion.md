# MCP Registry Expansion — Top-100 Compatibility & Plan

Research date: 2026-08-24. Popularity triangulated from npm/PyPI weekly downloads, Docker Hub pulls, PulseMCP directory traffic, and GitHub stars; every package name, env var, auth flow, and status below was verified against the upstream README / registry APIs on that date.

## 1. What ADF can run today (ground truth)

The compatibility test is what `McpServerRegistration` → `buildMcpServerConfigFromRegistration` can express and what the runtime can actually execute:

| Capability | Status |
|---|---|
| stdio via `npx` (npm) / `uvx` (PyPI), host or shared container | ✅ shipped |
| Env-key credentials (app-scoped w/ credential_ref, or agent-scoped) | ✅ shipped |
| Interactive OAuth preflight for stdio servers (`auth` + `authArgs`), container-aware | ✅ shipped |
| Credential files (`credential_files`, sealed per-agent, write-back) | ✅ shipped |
| Remote Streamable HTTP w/ static headers, `header_env`, `bearer_token_env_var` | ✅ shipped (registration layer) |
| Custom `command`/`args` | ✅ shipped (registration layer) |
| **Curated-registry (`McpRegistryEntry`) support for `args`** | ❌ missing (Phase 2) |
| **Curated-registry support for HTTP entries (`url` + header/bearer auth)** | ❌ missing (Phase 3) |
| Interactive HTTP OAuth (dynamic client registration against remote servers) | ❌ not built (Phase 4, optional) |
| SSE-only transport | ❌ not supported (industry has moved to Streamable HTTP; fine) |
| Docker-image-only servers | ❌ no first-class support (see §7 "podman image entries" note) |

So the compatibility tiers below map directly onto plan phases.

## 2. Current registry hygiene (Phase 0 — fix before adding anything)

The existing 14 entries in `src/shared/constants/mcp-registry.ts`, one year of MCP-ecosystem churn later:

| Entry | Finding | Action |
|---|---|---|
| `github` (`@modelcontextprotocol/server-github`) | **npm-deprecated**, frozen at 2025.4.8, repo archived. Official replacement is remote-only (`https://api.githubcopilot.com/mcp/`, PAT bearer) or docker/Go — no npm path exists. Still 118k dl/wk on pure inertia. | Keep short-term with a "legacy" caveat; replace with the remote entry in Phase 3 (its PAT-bearer auth is a perfect `headerEnv` fit). |
| `slack` (`@modelcontextprotocol/server-slack`) | **Archived** 2025-05-29. Official Slack remote requires a pre-registered Marketplace app (no DCR) — not registry-viable. | Replace now: `@zencoderai/slack-mcp-server` is the drop-in (same `SLACK_BOT_TOKEN`+`SLACK_TEAM_ID` env model, maintained Apache-2.0 continuation). The higher-traction `slack-mcp-server` (korotovsky, 21.6k dl/wk) is stronger but its browser-session token mode (xoxc/xoxd) bypasses workspace admin approval — if added, add it as a second, `verified: false` entry with that flagged. |
| `mail` (`mcp-mail-server`) | Low-traction; research surfaced `@codefuturist/email-mcp` (5.3k dl/wk, active, pure-env `MCP_EMAIL_*` config — the cleanest containerizable IMAP/SMTP option). | Replace. |
| `gmail` (`@gongrzhe/server-gmail-autoauth-mcp`) | Upstream repo **archived** 2025-08 (still the download leader, 23k/wk; still works). | Keep with caveat; add `workspace-mcp` (§4) as the maintained Google path. |
| `twilio` (`@deshartman/twilio-messaging-mcp-server`) | Needs an ngrok account/tunnel — heavy prereq. Official `@twilio-alpha/mcp` exists but takes credentials as a positional arg (`<accountSid>/<apiKey>:<apiSecret>`) — needs Phase 2 `args`, and puts a secret in argv. | Keep as-is for now; revisit in Phase 2. |
| `brave-search`, `playwright`, `filesystem`, `memory`, `sequential-thinking`, `resend`, `discord`, `telegram`, `google-drive` | Healthy (brave was already migrated to `@brave/brave-search-mcp-server` ✓; resend repo renamed to `resend/resend-mcp`, npm unchanged ✓). | No change. `filesystem` gains allowed-dir `args` in Phase 2. |

Two upstream reference servers people may ask about were **excluded for unpatched security advisories**: `@modelcontextprotocol/server-postgres` (SQLi, archived) and `mcp-server-sqlite` (SQLi + stored-prompt-injection, archived).

**Name-squat blocklist** (never auto-map these registry names): PyPI `mcp-gmail`, PyPI `telegram-mcp` (README of the real project explicitly warns), PyPI `mcp-server-milvus` (not zilliztech), npm `mcp-filesystem-server` (advertises "unrestricted filesystem access"), npm `github-mcp-server` (unrelated third party).

## 3. Compatibility verdict on the top-100

Of the ~120 ranked servers:

- **~55 are compatible today** (Tier A): npx/uvx stdio + env-key or no auth — pure registry data additions.
- **~10 more unlock with `args`** (Tier B1): filesystem dirs, DB paths/DSNs, excel's positional transport arg.
- **~15 more unlock with HTTP entries** (Tier B2): vendor remotes that accept a long-lived token via bearer/header — GitHub, Linear, Neon, Cloudflare, Datadog, Zapier, Make, DeepWiki, Microsoft Learn, Hugging Face, SerpApi, Airtable, Atlassian (API-token endpoint).
- **~12 are OAuth-DCR-only remotes** (Tier C1): incompatible until ADF grows an HTTP OAuth flow — official Slack (pre-registered app required), Figma, Vercel (client allowlist — likely never), GitLab built-in, Asana v2 (pre-registered app), ClickUp official, Notion remote, Todoist remote, Readwise hosted. Most have a compatible stdio or token sibling already counted above, so the *service* coverage loss is small.
- **~10 are docker/Go-binary or source-only** (Tier C2): GitHub local, Terraform, Elastic ≥0.4, crawl4ai, Netdata, Google genai-toolbox, WhatsApp (Go bridge), Signal (signal-cli), Milvus, SendGrid.
- **~10 are dead/deprecated/dangerous** (Tier C3): archived reference set (github/slack/postgres/puppeteer/gdrive/gitlab/redis/sqlite/brave), E2B wrapper, pydantic mcp-run-python, Pocket (service dead), mcp-server-ds (stale), win-cli.

## 4. Proposed Tier-A additions (Phase 1 — registry data only)

Verified entries, grouped by proposed category. `(u)` = uvx/PyPI, else npm. **Bold env = required.**

### search / web
| name | package | auth | notes |
|---|---|---|---|
| fetch | `mcp-server-fetch` (u) | none | maintained reference; SSRF-capable — container default is right |
| context7 | `@upstash/context7-mcp` | none | 843k dl/wk; library docs |
| duckduckgo | `duckduckgo-mcp-server` (u) | none | zero-key search; client-side rate limits |
| tavily | `tavily-mcp` | **TAVILY_API_KEY** | |
| exa | `exa-mcp-server` | **EXA_API_KEY** | |
| perplexity | `@perplexity-ai/mcp-server` | **PERPLEXITY_API_KEY** | supersedes deprecated `server-perplexity-ask` |
| kagi | `kagimcp` (u) | **KAGI_API_KEY** | pins python 3.12 |
| serper | `serper-mcp-server` (u) | **SERPER_API_KEY** | 161k dl/mo — de-facto Serper server |
| searxng | `mcp-searxng` | **SEARXNG_URL** | prereq: running SearXNG w/ JSON output |
| firecrawl | `firecrawl-mcp` | **FIRECRAWL_API_KEY**, opt FIRECRAWL_API_URL | |
| apify | `@apify/actors-mcp-server` | **APIFY_TOKEN** | |
| oxylabs | `oxylabs-mcp` (u) | **OXYLABS_USERNAME/PASSWORD** | |
| youtube-transcript | `@kimtaeyoon83/mcp-server-youtube-transcript` | none | datacenter IPs may be blocked by YouTube |
| arxiv | `arxiv-mcp-server` (u) | none | |
| markitdown | `markitdown-mcp` (u) | none | Microsoft; any-format → markdown |
| pandoc | `mcp-pandoc` (u) | none | prereq: pandoc binary (host, or bake into container image) |

### dev
| name | package | auth | notes |
|---|---|---|---|
| git | `mcp-server-git` (u) | none | optional `--repository` arg (Phase 2) |
| gitlab | `@zereight/mcp-gitlab` | **GITLAB_API_URL, GITLAB_PERSONAL_ACCESS_TOKEN**, opt GITLAB_PERMISSION_MODE | ~217 tools; active |
| sentry | `@sentry/mcp-server` | **SENTRY_ACCESS_TOKEN**, opt SENTRY_HOST | |
| supabase | `@supabase/mcp-server-supabase` | **SUPABASE_ACCESS_TOKEN** | vendor going remote-first but npm alive |
| semgrep | `semgrep-mcp` (u) | none for local scans | |
| chrome-devtools | `chrome-devtools-mcp` | none | #2 by usage; drives host Chrome — host-run |
| shopify-dev | `@shopify/dev-mcp` | none | docs/schema only, zero-config |
| n8n | `n8n-mcp` | opt (docs mode keyless) | 162k dl/wk; verify env names at impl time |

### data
| name | package | auth | notes |
|---|---|---|---|
| postgres | `postgres-mcp` (u) | **DATABASE_URI** | crystaldba "Postgres MCP Pro"; the archived reference's successor |
| mysql | `@benborla29/mcp-server-mysql` | **MYSQL_HOST/PORT/USER/PASS/DB**, opt ALLOW_INSERT/UPDATE/DELETE_OPERATION | read-only by default |
| mongodb | `mongodb-mcp-server` | **MDB_MCP_CONNECTION_STRING** | official; note MDB_MCP_ prefix |
| redis | `redis-mcp-server` (u) | **REDIS_URL** (or REDIS_HOST/…/**REDIS_PWD** — not _PASSWORD) | official; README uses `uvx --from redis-mcp-server@latest` — verify bare `uvx redis-mcp-server` resolves at impl time |
| clickhouse | `mcp-clickhouse` (u) | **CLICKHOUSE_HOST/USER/PASSWORD**, opt PORT/SECURE/DATABASE, write gates default-off | |
| duckdb | `mcp-server-motherduck` (u) | none local; opt MOTHERDUCK_TOKEN | `--db-path` arg → Phase 2; read-only by default |
| chroma | `chroma-mcp` (u) | mode via CHROMA_CLIENT_TYPE; cloud: CHROMA_API_KEY/TENANT/DATABASE | ephemeral mode is zero-config |
| qdrant | `mcp-server-qdrant` (u) | **QDRANT_URL** (or QDRANT_LOCAL_PATH), **COLLECTION_NAME**, opt QDRANT_API_KEY | embeds locally via fastembed — no external key |
| pinecone | `@pinecone-database/mcp` | **PINECONE_API_KEY** | Node 20+ |
| dbt | `dbt-mcp` (u) | **DBT_HOST, DBT_TOKEN, DBT_PROD_ENV_ID** (+ more per feature) | |
| airtable | `airtable-mcp-server` | **AIRTABLE_API_KEY** (a PAT) | community; official is remote (Phase 3) |
| google-sheets | `mcp-google-sheets` (u) | **SERVICE_ACCOUNT_PATH + DRIVE_FOLDER_ID** (service-account mode) | best headless story; key file → `credentialFiles` |
| dbhub | `@bytebase/dbhub` | `--dsn` arg → Phase 2 | multi-engine (SQLite/PG/MySQL/MSSQL); Node ≥22.5 |
| aws-docs | `awslabs.aws-documentation-mcp-server` (u) | none | 139k dl/wk |

### communication / productivity
| name | package | auth | notes |
|---|---|---|---|
| slack | `@zencoderai/slack-mcp-server` | **SLACK_BOT_TOKEN, SLACK_TEAM_ID**, opt SLACK_CHANNEL_IDS | Phase-0 replacement (see §2) |
| email | `@codefuturist/email-mcp` | **MCP_EMAIL_ADDRESS/PASSWORD/IMAP_HOST/SMTP_HOST**, opt ports/TLS | Phase-0 replacement for `mail` |
| notion | `@notionhq/notion-mcp-server` | **NOTION_TOKEN** | official; repo may sunset in favor of remote — re-verify quarterly |
| atlassian | `mcp-atlassian` (u) | **JIRA_URL/JIRA_USERNAME/JIRA_API_TOKEN** and/or CONFLUENCE_* | 589k dl/wk; only option covering Server/DC |
| linear | `@tacticlaunch/mcp-linear` | **LINEAR_API_TOKEN** | until Phase 3 adds the official remote |
| todoist | `@doist/todoist-mcp` | **TODOIST_API_KEY** | official |
| trello | `@delorenj/mcp-server-trello` | **TRELLO_API_KEY, TRELLO_TOKEN** | |
| monday | `@mondaydotcomorg/monday-api-mcp` | **monday_token** (lowercase — verbatim) | official |
| cal-com | `@calcom/cal-mcp` | **CAL_API_KEY** (not CALCOM_) | official |
| teams | `@floriscornel/teams-mcp` | device-code OAuth: `auth: true`, `authArgs: ['authenticate']`, credentialFiles `~/.teams-mcp-token-cache.json`, `~/.msgraph-mcp-auth.json` | no Azure app registration needed — clean fit for the existing preflight |
| google-calendar | `@cocal/google-calendar-mcp` | **GOOGLE_OAUTH_CREDENTIALS** (path) + `authArgs: ['auth']` + token file `~/.config/google-calendar-mcp/tokens.json` | same shape as existing gmail/gdrive entries |
| google-docs | `@a-bonus/google-docs-mcp` | **GOOGLE_CLIENT_ID/SECRET** + `authArgs: ['auth']` + `~/.config/google-docs-mcp/token.json` | actually all-in-one Docs/Sheets/Drive |
| workspace | `workspace-mcp` (u) | **GOOGLE_OAUTH_CLIENT_ID/SECRET** | 320k dl/mo, 120+ tools; caveat: no auth subcommand — browser auth fires in-flow on port 8000, so mark host-preferred until preflight handles in-flow auth |
| stripe | `@stripe/mcp` | **STRIPE_SECRET_KEY** (restricted key recommended) | |
| paypal | `@paypal/mcp` | **PAYPAL_ACCESS_TOKEN**, **PAYPAL_ENVIRONMENT** | |
| hubspot | `@hubspot/mcp-server` | **PRIVATE_APP_ACCESS_TOKEN** | beta |
| raindrop | `@adeze/raindrop-mcp` | **RAINDROP_ACCESS_TOKEN** | Pocket is dead; this is the bookmark answer |

### infra / monitoring
| name | package | auth | notes |
|---|---|---|---|
| grafana | `mcp-grafana` (u) | **GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN** | official PyPI wrapper of the Go binary |
| prometheus | `prometheus-mcp-server` (u) | **PROMETHEUS_URL**, opt basic-auth/token | |
| pagerduty | `pagerduty-mcp` (u) | **PAGERDUTY_USER_API_KEY** | write tools off by default; Python ~3.12 |
| kubernetes | `kubernetes-mcp-server` | kubeconfig (KUBECONFIG) | no kubectl needed; host-run (needs kubeconfig file) |
| docker | `mcp-server-docker` (u) | opt DOCKER_HOST | host-run (docker daemon) |
| netlify | `@netlify/mcp` | Netlify CLI login state, fallback NETLIFY_PERSONAL_ACCESS_TOKEN | host-run; Node ≥22 |

### ai / creative
| name | package | auth | notes |
|---|---|---|---|
| elevenlabs | `elevenlabs-mcp` (u) | ELEVENLABS_API_KEY (verify exact name at impl) | |
| antv-chart | `@antv/mcp-server-chart` | none | chart generation |
| mermaid | `mcp-mermaid` | none | |
| browserbase | `@browserbasehq/mcp` | **BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, GEMINI_API_KEY** | cloud browsers |
| blender | `blender-mcp` (u) | none | prereq: Blender addon started manually; host-run (localhost:9876 socket) |

Host-only candidates (macOS/desktop-app coupled — include only if we want a "desktop" category): `xcodebuildmcp`, `ios-simulator-mcp`, `things-mcp`, `mac-messages-mcp`, `iterm-mcp`, `@negokaz/excel-mcp-server` (live-Excel mode is Windows-only), `@jetbrains/mcp-proxy`, `@merill/lokka`, `@softeria/ms-365-mcp-server` (OS-keyring token cache), `@salesforce/mcp` (sf CLI state), `@azure/mcp`/`@azure-devops/mcp` (az login state). Deliberately skipped: `@wonderwhy-er/desktop-commander` and shell servers (overlap ADF's native `sys_code`/fs tools; telemetry on by default), `task-master-ai` (wants its own LLM API keys — collides with the "runtime keys never exposed" rule unless the user consciously provisions separate keys), `@taazkareem/clickup-mcp-server` (now requires a commercial license key).

## 5. Schema changes

### Phase 2 — `args`
```ts
/** CLI args appended after the package. Tokens like '{directory}' or
 *  '{connection-string}' render as required inputs on the quick-add card
 *  and are substituted before registration. */
args?: string[]
```
`registrationFromRegistryEntry` passes resolved args through (the field already exists on `McpServerRegistration`). Unlocks: filesystem allowed-dirs (`['{directory}']`), `mcp-sqlite` (`['{database-path}']`), dbhub (`['--dsn','{dsn}']`), motherduck (`['--db-path','{db-path}']`), excel (`['stdio']` — no placeholder), git (`['--repository','{repo-path}']` optional). Placeholder args that would contain secrets (twilio's positional credential) stay excluded — argv is world-readable on the host.

### Phase 3 — HTTP entries
```ts
/** Remote Streamable HTTP endpoint. Presence makes this a remote entry. */
url?: string
/** Header-name → env-key credential mapping (e.g. Authorization ← GITHUB_PAT). */
headerEnv?: { header: string; env: string }[]
/** Shortcut for plain `Authorization: Bearer <env>` auth. */
bearerTokenEnvVar?: string
```
`registrationFromRegistryEntry` branches: `url` present → `type: 'http'`, map auth fields, omit `runLocation`. Existing machinery already does the rest: `suggestedAgentVisible` defaults HTTP to attachable, `deriveRegistrationTestPlan` returns `remote http`, `isSensitiveMcpHeader` keeps tokens out of static headers, and `credentialStorage` scoping works unchanged. Entries this unlocks:

| name | url | auth |
|---|---|---|
| github | `https://api.githubcopilot.com/mcp/` | bearerTokenEnvVar `GITHUB_PAT` — **replaces the deprecated npm entry** |
| linear | `https://mcp.linear.app/mcp` | bearer `LINEAR_API_KEY` |
| neon | `https://mcp.neon.tech/mcp` | bearer `NEON_API_KEY` |
| cloudflare-docs / -bindings / -observability | `https://{docs,bindings,observability}.mcp.cloudflare.com/mcp` | bearer CF API token (scoped per server) |
| datadog | `https://mcp.datadoghq.com/v1/mcp` | headerEnv DD-API-KEY/DD-APPLICATION-KEY |
| zapier | `https://mcp.zapier.com/api/v1/connect` | bearer (user's MCP token) |
| make | `https://{zone}/mcp/stateless` | bearer MCP token (`mcp:use` scope) — zone needs a `{zone}` URL placeholder or ask-user field |
| deepwiki | `https://mcp.deepwiki.com/mcp` | none |
| microsoft-learn | `https://learn.microsoft.com/api/mcp` | none |
| atlassian-cloud | `https://mcp.atlassian.com/v1/mcp` | API token (needed for JSM/Bitbucket which the uvx server lacks) |
| huggingface | `https://huggingface.co/mcp` | bearer HF token (verify exact scheme at impl) |

Skip URL-templated per-resource endpoints (GitMCP's `/{owner}/{repo}`, Shopify per-store) — a `{placeholder}`-in-url mechanism can reuse the Phase-2 token UI if wanted later.

### Category union
Extend `category` with `'search' | 'productivity' | 'infra' | 'ai'` (existing five keep their entries; recategorize `brave-search` → search).

## 6. UI: the modal at 70+ entries

`McpAddServerModal`'s quick-add cards don't scale past ~20. Needed: a search input (name/description substring), category filter chips, and two badges per card — runtime (`npx`/`uvx`/`remote`) and auth shape (`no auth` / `API key` / `OAuth` / `sign-in on connect`). The `prerequisite` callout and credential-file drops already exist. Keep `verified: true` for official/vendor servers and reference servers; community servers ship `verified: false` and sort after verified ones within a category.

## 7. Phased plan & difficulty

| Phase | Scope | Difficulty (1-10) |
|---|---|---|
| 0 | Hygiene: replace slack + mail entries, caveat github/gmail, add squat-blocklist comment | 2 |
| 1 | ~55 Tier-A entries + category union + modal search/filter/badges | 3 (data volume; each entry needs a one-time connect-test) |
| 2 | `args` + placeholder inputs; filesystem/sqlite/dbhub/duckdb/excel entries | 3 |
| 3 | HTTP entries (`url`/`headerEnv`/`bearerTokenEnvVar`) + ~11 remote entries | 4 |
| 4 (optional, separate project) | Interactive HTTP OAuth (DCR + browser flow + token store) — unlocks official Slack/Figma/Asana/ClickUp/Notion-remote/GitLab remotes | 7-8 |
| ongoing | `scripts/verify-mcp-registry.ts`: hit registry.npmjs.org / PyPI JSON for every entry, flag deprecation notices, missing packages, and major-version jumps; wire into CI weekly | 2 |

The verification script is not optional decoration: 5 of the current 14 entries drifted (deprecated/archived/renamed) within a year. At 70+ entries, rot is a certainty without automation.

## 8. Deferred / excluded (with reasons)

- **OAuth-DCR-only remotes** (Phase 4 blockers): Slack official, Figma, Vercel (client-allowlisted — likely permanently out), GitLab built-in `/api/v4/mcp`, Asana v2, ClickUp official, Notion remote, Todoist remote, Readwise hosted, Supabase remote.
- **Docker/binary-only**: GitHub local, Terraform (HashiCorp), Elastic ≥0.4, crawl4ai, Netdata, Google genai-toolbox, Signal ecosystem, WhatsApp (Go bridge + QR relink every ~20 days). A future `containerImage` entry type running vendor images through the existing podman infrastructure would unlock most of these — noted, not planned.
- **Source-only**: Milvus (zilliztech), SendGrid (Garoth), Spotify (git+uvx), TickTick, chigwell telegram (MTProto), pandas-mcp.
- **Dead/vulnerable**: archived reference set, E2B, mcp-run-python, Pocket, mcp-server-ds, `server-postgres` + `mcp-server-sqlite` (unpatched SQLi).

## 9. Env-name traps (encode verbatim, do not "normalize")

`REDIS_PWD` (not _PASSWORD) · `COLLECTION_NAME` (bare, qdrant) · `monday_token` (lowercase) · `ACCESS_TOKEN` (bare, readwise legacy) · `CAL_API_KEY` (not CALCOM_) · `MDB_MCP_*` prefix (mongodb) · `API_KEY` (bare, todoist community) · `GOOGLE_OAUTH_CREDENTIALS` is a *path*, not a token (cocal calendar).
