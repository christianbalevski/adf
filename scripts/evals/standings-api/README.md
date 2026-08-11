# standings-api eval

Task-based capability eval: the agent receives a one-shot mission over the ALF
mesh, gathers live data with its Playwright MCP browser, self-configures a
served API route, and reports back — all on the headless daemon.

## Mission (sent by the eval runner over ALF)

> Using your Playwright browser tools, get the current English Premier League
> table from https://www.bbc.com/sport/football/premier-league/table.
> Serve it at `GET /standings` on your API as JSON in exactly this shape:
> `{"updated_at": "<ISO8601>", "source": "<page url>", "standings": [{"pos": 1, "team": "...", "played": 0, "points": 0}, ... all 20 teams]}`
> Verify your route returns valid data. When done, reply to this message with
> the full URL of your /standings route, then return to idle.

No recurring refresh — one-shot. The agent must end in **idle** (not off) so
its served routes remain reachable for grading.

## Fixture contract

- `agent-1`, starts in `idle` (agent-scope triggers still fire in idle)
- `sys_update_config` enabled + `restricted: false` — no HIL gate on config
  (needed to self-register the serving route; HIL blocks forever on the daemon)
- `compute: { enabled: true, host_access: false }` — isolated container
  attached; `locked_fields: ["compute.host_access"]` blocks both the leaf and
  wholesale `compute` replacement, so the agent cannot enable host compute
- Playwright stdio MCP (`npx @playwright/mcp`), `source` field set so the
  daemon settings registry check cannot silently skip it; `mcp_playwright_*`
  tools pre-declared unrestricted so the tool sync does not re-gate them
- dynamic-instruction nudges off; `umbilical: { log: true }` for the ledger

## Run procedure

```bash
JOB=/tmp/standings-eval   # any scratch dir

# 1. isolated daemon settings (providers copied, autostart emptied, playwright registered)
node scripts/evals/standings-api/make-settings.mjs --out $JOB/settings.json

# 2. fixture (runner DID from alf_whoami)
npx tsx scripts/evals/standings-api/make-fixture.ts \
  --out $JOB/agent-1.adf --runner-did <did> --provider <provider-id> --model <model-id>

# 3. daemon
ADF_DAEMON_SETTINGS=$JOB/settings.json ADF_DAEMON_PORT=7385 npm run daemon
# wait for GET /health -> {ok:true}

# 4. load + verify idle
curl -X POST 127.0.0.1:7385/agents/load -H 'content-type: application/json' \
  -d '{"filePath":"'$JOB'/agent-1.adf"}'

# 5. HIL auto-responder (mandatory — an unapproved restricted call hangs the run)
node scripts/evals/standings-api/approver.mjs --agent <agentId>

# 6. send the mission over ALF (alf_send to agent-1's DID / mesh inbox), then
#    wait for the agent's reply in the runner inbox

# 7. grade
node scripts/evals/standings-api/grade.mjs --adf $JOB/agent-1.adf \
  --agent <agentId> --runner-did <did> --out $JOB/report.json
```

## Checks

| # | Check | Method |
|---|---|---|
| 1 | schema | `GET mesh:/agents/agent-1/standings` — 200, exact shape, 20 rows, pos 1..20 |
| 2 | truth | grader re-fetches the BBC page; every served team must appear; points non-increasing |
| 3 | reply | `adf_outbox` row to runner DID containing the /standings URL; mission row in `adf_inbox` |
| 4 | state | daemon status = `idle` (not off — routes must stay reachable) |
| 5 | metrics | token/tool/turn ledger from umbilical replay ring (`adf_loop` fallback) |

Benchmark record = the grade report's metrics block; baseline = median of 5
runs at pinned model + harness version.
