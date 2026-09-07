---
type: reference
description: General software-engineering practice for ADF agents and humans — isolated workspaces, GitHub access checks, identity-owned credentials, bounded delegation, and accountable delivery
see_also:
  - ../guides/compute.md — isolated/shared/host execution targets, workspaces, lifecycle, approvals, and security boundaries
  - ../guides/security-and-identity.md — identity ownership, envelope-sealed credentials, and secret handling
  - ../guides/inner-loops.md — bounded cognition streams, model/compaction overrides, pacing, and loop authority
  - ../guides/skills.md — reusable executable workflows and their security boundary
---

# Engineering Work with Isolated Agents

This is a Knowledge Base article, written for general software-engineering work rather than ADF Studio-specific implementation. It describes a working pattern for humans and agents: put repository operations in a bounded isolated workspace, keep credentials identity-owned, delegate bounded work to explicit workers, and make the main/orchestrator accountable for review and delivery.

The article is intentionally not a feature contract. Read the linked [Compute guide](../guides/compute.md), [Security and Identity guide](../guides/security-and-identity.md), [Inner Loops guide](../guides/inner-loops.md), and [Skills guide](../guides/skills.md) for canonical runtime behavior and security rules. The observations below are experience reports, not performance benchmarks or universal prescriptions.

## Evidence grades

- **Source-verified** means the current repository/runtime contracts support the statement. It does not mean every deployment or external service has been tested.
- **Observed lesson** means it came from our engineering work and should guide practice, but it is not a universal law.
- **Unverified guidance** is a sensible proposal that still needs a controlled test before being presented as a supported guarantee.

Keep those categories visible. A successful experiment, a worker's report, or a GitHub check is not automatically a product contract.

## 1. Isolated workspace and lifecycle

### Source-verified

- A managed isolated target is dedicated to one agent; its workspace is `/workspace/`. The shared target uses a namespaced workspace such as `/workspace/{agentId}/`, and is not agent-isolated.
- `compute_exec` runs a shell command in the selected authorized target. The managed container path is a one-shot `sh -c` execution with bounded timeout; a shell background operator is not a general persistence mechanism.
- Managed isolated containers are stopped, not removed, on ordinary agent stop, so files and installed packages can be reused on a later start. Explicit rebuild/destroy removes state. Stopping a container also stops its running processes; a later start must relaunch them.
- Target selection is allowlisted/defaulted and fails closed when unavailable. Do not assume an unavailable target silently becomes another container or the host.
- Host execution is a separate high-trust capability with the user's OS privileges. Do not enable host access merely to avoid designing a clean isolated workflow.

### Practical workflow

1. Give each substantial task a dedicated isolated workspace or a uniquely named checkout directory. Keep generated reports, logs, patches, and test artifacts under a known workspace path.
2. Before changing anything, record repository, branch, revision, and `git status --short --branch`.
3. Prefer a fresh clone or a separate worktree when several workers may touch the same repository. Do not let parallel workers share a mutable checkout unless the ownership and serialization rule is explicit.
4. At the end, record the exact report path, changed paths, checks run, and remaining uncertainty. Container persistence is not backup: transfer important artifacts to an explicitly managed durable destination.
5. On restart, verify the workspace and revision again; do not infer that a process, server, detached GUI, or test runner survived because the container filesystem survived.

### Observed lessons

- A retained container is useful for continuity, but it makes stale state easy to mistake for fresh evidence. A clean-start check and explicit revision/status record are cheaper than debugging an unexplained mixed result.
- Shared checkouts create avoidable collisions: workers can overwrite files, change branches, or invalidate each other's status and test assumptions. Separate directories plus a main-owned integration step are the safer default.

### Unverified guidance

The exact durability of a managed container across machine loss, runtime upgrade, storage pressure, or operator cleanup must be tested for the deployment in question. Do not document stopped-container reuse as a backup, portability, or disaster-recovery guarantee.

## 2. GitHub clone, push, and PR access checks

Treat access as several independent capabilities, not one boolean “GitHub works” result.

### Check in increasing order of consequence

1. **Identity/account check:** use the identity-owned GitHub credential to call a harmless account endpoint, without printing its value. Record the authenticated account, not the token.
2. **Repository read check:** clone or fetch the intended repository and verify the expected remote, branch, revision, and clean starting status.
3. **Git transport check:** run a read-only `git ls-remote` or equivalent against the intended remote.
4. **Push authorization check:** use a harmless branch/ref namespace and `git push --dry-run` where the server supports it. A dry run tests part of Git transport and repository authorization; it does not create a remote branch.
5. **Actual PR capability check:** only when explicitly authorized, create a disposable or real branch/PR through the supported GitHub path, then inspect the result and clean up according to the principal's request. Account-level repository permissions and a successful push dry run do **not** prove that the token can create pull requests. In our experience, actual PR creation was the evidence that closed that question.

Keep the account, repository, branch, push, and PR results separate in the report. Do not claim PR permission from `/user`, repository permission fields, `git ls-remote`, or push dry-run alone.

### Safe repository practice

- Clone into the isolated workspace, not into a shared mutable checkout used by another worker.
- Use an explicit branch name and inspect `git status` before and after work.
- Never put a token into a remote URL, committed file, report, shell history, screenshot, or log.
- Do not claim that a push or PR happened until the remote result, branch/PR URL or identifier, and final status have been inspected.
- If the principal requested draft-only work, do not turn a capability check into a push or PR.

## 3. Credentials and identity ownership

### Source-verified

ADF separates owner, runtime, and agent identity and protects credentials in the credentials envelope rather than treating a copied `.adf` file as possession of its secrets. Identity/credential access remains subject to the runtime's identity and approval boundaries; an inner worker does not receive a new identity or an independent credential store merely because it was delegated work.

### Required handling rules

- Credentials stay identity-owned. Retrieve them through the supported identity mechanism at the point of use; do not ask workers to paste secrets into messages or reports.
- Never write token values to documentation, logs, reports, source files, screenshots, shell history, or Git remotes.
- Treat command arguments, process listings, task records, audit events, and tool logs as potentially observable. A secret can leak even when it was not written to disk.
- Do not embed credentials in generated shell commands or subprocess scripts. Transient command construction can still expose them through auditing and process inspection; verify the credential transport before using it.
- Prefer a credential helper, identity-aware runtime path, or short-lived environment/IPC handoff whose exposure is understood. Redact outputs and verify that the chosen transport does not echo arguments.
- If a credential may have appeared in a command, log, remote URL, or artifact, treat it as exposed: stop using it, rotate/revoke it through the owner, and record only the incident and remediation—not the secret.

### Unverified guidance

The exact exposure behavior of a particular Git client, shell, wrapper, CI runner, MCP server, or audit pipeline varies by environment. Verify it with a harmless fixture or documented vendor behavior before calling a credential transport safe. “Not persisted in the remote URL” is necessary but not sufficient.

## 4. Bounded loops and model roles

### Source-verified

An inner loop is a cognition stream inside one agent. It shares the agent's `.adf` body, memory, filesystem, identity, and credentials; it can narrow tools, goal, pacing, model, and compaction threshold, but it does not become a second agent. Main owns outside-world actions. Loop tool access is an attenuation of the agent's existing capability, not a permission escalation.

The runtime supports optional per-loop model and compaction overrides subject to the guide's constraints. A model override may change which model a loop uses, but it does not create new credentials or a new provider identity; cross-provider and code-execution requirements still apply.

### Observed delegation pattern

Use a **stronger, costlier orchestrator/reviewer** for work that requires synthesis, prioritization, security judgment, or final accountability. Use **cheaper execution/research workers** for bounded tasks with a concrete output contract: inspect a named subsystem, run a specified check, compare two files, or draft a report section.

This is a role choice, not a benchmark claim. Pricing, speed, and quality differences depend on provider, prompt, context, workload, and date. We have not established a general performance ranking or cost curve; do not write “model X is faster/better/cheaper” as measured fact without a controlled benchmark.

A useful dispatch contract includes:

- one bounded task and one owner;
- the exact output path, filename, or structured return expected;
- source/revision/scope limits;
- allowed tools and target environment;
- an explicit completion signal back to main, such as `DONE` with the report path;
- the worker's uncertainties and checks, not only its narrative conclusion;
- a no-escalation rule: workers do not enable tools, alter runtime permissions, grant credentials, change owner locks, or broaden their target.

Keep workers autonomous within that contract, but keep final review, external messaging, branch integration, and publication with main unless the principal explicitly delegates those acts.

### Failure lessons

- **60k compaction churn:** A deep repo investigation with a worker compaction threshold around 60k repeatedly compacted, losing continuity and spending turns reconstructing context. We chose at least **200k** for our deep-review workers. This is our operating choice, not a universal threshold; select it against the model context window, task depth, and cost budget.
- **Idle does not mean delivered:** We observed workers marked idle while the expected report/output was missing. Worker state is not proof of artifact completion. Main must check the named path, inspect the content, and verify the completion signal.
- **Narrated success is insufficient:** A worker saying it “finished” is weaker than a present report, status/diff evidence, and checks that can be rerun. Require explicit report paths and completion signals in every dispatch.
- **Main remains accountable:** Delegation transfers bounded execution, not judgment. Main reviews evidence, resolves conflicts, checks scope, decides whether claims are supported, and owns any branch/PR/channel action.
- **No runtime permission escalation:** A worker that lacks `compute_exec`, identity access, host access, or a restricted tool must report the limitation. It must not enable tools, modify security controls, request a broader target on its own authority, or smuggle credentials through another loop.

### Unverified guidance

The best number of workers, compaction threshold, model mix, and dispatch fan-out for a new project remain workload-specific. Start with a small bounded assignment, measure artifact completeness and review effort, then adjust. Do not optimize for worker count, idle time, or token spend alone.

## 5. Delivery and review checklist

Before declaring engineering work complete, main should confirm:

- [ ] The task had a bounded scope and named owner.
- [ ] The isolated target/workspace, repository, branch, and starting revision were recorded.
- [ ] Parallel workers had separate checkouts or an explicit serialized ownership rule.
- [ ] Every worker had an exact output path and explicit completion signal.
- [ ] Expected artifacts actually exist and are readable at those paths.
- [ ] Main reviewed the artifact, source evidence, status/diff, and checks.
- [ ] GitHub account/read/push/PR capabilities are reported separately; PR capability is not inferred from dry-run results.
- [ ] Credentials never appear in docs, logs, remotes, command output, or screenshots; any uncertain exposure was rotated.
- [ ] No worker escalated runtime permissions or acted outside its assigned target.
- [ ] Unverified claims are labeled, and pricing/speed/quality language is not presented as benchmark evidence.
- [ ] The final message names changed paths, checks, uncertainties, and any remote result.

## Dependency and delivery lessons

A git worktree isolates tracked files, not dependency directories or native ABIs. Resolve node_modules symlinks before deleting or rebuilding packages. Use independent dependency trees and record Node/Electron versions and native ABI with test results. npm install --no-save --package-lock=false can still change unrelated installed dependencies; prefer clean lockfile-based staging and verify it before switching environments. One successful SQLite query does not establish restoration of a drifted dependency tree.

Worker completion must trigger review and integration, not merely acknowledgment. Repeatedly yielding after outputs arrived left authorized work unfinished in this experience. Use explicit follow-ups and inspectable deliverables; a deadline promise alone does not schedule work.
