---
type: reference
description: Run visible Linux desktop applications in isolated compute, transfer files, and validate visual results without assuming generic desktop automation
see_also:
  - ../guides/compute.md — compute targets, configuration, approvals, and security boundaries
  - ../guides/browser.md — the managed Chromium session, noVNC viewer, and authentication handoff
  - ../guides/documents-and-files.md — the agent VFS and file protection
---

# Desktop Applications with Isolated Compute

ADF can run real Linux GUI processes in an agent's managed **isolated** container. This is useful when a task needs a native PDF or image viewer, an editor, or another desktop application that is already present in the image. The capability is a process-and-display environment, not a claim that ADF ships a full desktop, an application catalog, or a universal GUI automation API.

This article composes a task recipe; it does not replace the feature contracts in the [Compute Environments guide](../guides/compute.md), [Visible Browser guide](../guides/browser.md), or [Documents and Files guide](../guides/documents-and-files.md). Follow those guides for canonical configuration, browser lifecycle, file-protection, and security procedures. An installable executable workflow belongs in a skill, not in this article.

## Capability boundary

### Source-verified capabilities

- `compute_exec` runs real shell commands in the selected compute environment. An isolated agent container uses `/workspace` as its working directory.
- When isolated compute has browser display support enabled (`compute.enabled: true` and `compute.browser` not `false`), managed agent-container processes receive `DISPLAY=:99`. The display is shared by processes in that **same isolated container**: a GUI process can render there while the user watches the container's VNC/noVNC view.
- ADF starts a display stack in that container (X server, a small window manager, VNC, and a loopback-published noVNC endpoint). The Studio viewer embeds that noVNC page and can show the X display; it is not a second desktop session.
- `fs_transfer` moves files between the agent VFS and `isolated` or `shared` managed containers. Paths are relative to the selected endpoint and must not escape it. External containers are not file-transfer endpoints in this release.
- The maintained `@playwright/mcp` integration attaches to ADF's managed Chromium through its container-loopback CDP endpoint. This is the supported agent automation mechanism for web pages.

The `shared` target is a different, multi-agent container. Its workspace is namespaced under `/workspace/{agentId}`. The source exposes the visible `DISPLAY=:99` capability for browser-enabled **isolated** containers; do not infer that a shared-container command has a GUI display. Use isolated compute when a task needs a dedicated visible desktop process.

### Not generic desktop control

ADF does not expose a general pointer/keyboard/window-control tool for arbitrary Linux applications. Browser MCP is browser automation, not desktop automation. For a non-browser application, an agent can launch it, inspect its process/output, and exchange files; interaction must come from the application's own CLI/API or from the human using the visible viewer. Do not promise clicks, drag-and-drop, keyboard shortcuts, accessibility control, audio, printing, or GPU acceleration unless the application and environment have been separately verified.

## Prerequisites

1. The agent has `compute.enabled: true` and `compute.browser` left enabled when a visible display is required. These are agent configuration changes and may require human approval.
2. Podman and the managed compute service are available. If the selected target is unavailable, execution fails closed; ADF does not silently move the command to another container or the host.
3. The agent has access to `compute_exec` and, when files must cross the boundary, `fs_transfer`. Tool enablement and restricted-command approvals still apply.
4. The application is already installed in the image, or the owner has explicitly arranged the image/package configuration. Do not describe an app as installed merely because the default image contains Chromium and display dependencies; PDF editors, image editors, and office applications have not been verified as part of this capability.

Do not enable host access just to obtain a GUI. Host execution is a separate, high-trust target with the user's OS privileges; see [Compute Environments](../guides/compute.md#security-considerations).

## Workflow

### 1. Move inputs into the container

The VFS and container filesystem are separate. Transfer the input before launching the app:

```text
fs_transfer({
  from: "vfs",
  to: "isolated",
  path: "inputs/source.pdf",
  save_as: "inputs/source.pdf"
})
```

The destination is `/workspace/inputs/source.pdf` in the isolated container. For an output, reverse the endpoints:

```text
fs_transfer({
  from: "isolated",
  to: "vfs",
  path: "outputs/result.png",
  save_as: "outputs/result.png"
})
```

`from` and `to` must differ. `path` and `save_as` are relative paths; absolute paths and `..` escapes are rejected. Directory transfers are supported. Check the transfer result before relying on the file.

### 2. Check the application, then launch it on the shared display

Use `compute_exec` with the isolated target when the tool schema exposes a `target` field. If isolated is the sole authorized environment, the schema omits that field; omit `target` and ensure the configured default is isolated. Verify the binary first rather than assuming a package is present:

```text
compute_exec({
  command: "command -v my-viewer",
  target: "isolated"
})
```

For a short-lived operation, launch an available application with an explicit display, workspace path, and retained log. Apply the same target-field rule to this call:

```text
compute_exec({
  command: "mkdir -p /workspace/logs && DISPLAY=:99 my-viewer /workspace/inputs/source.pdf >/workspace/logs/my-viewer.log 2>&1",
  target: "isolated",
  timeout_ms: 120000
})
```

`compute_exec` runs `sh -c` through a one-shot container exec. Do not assume that appending `&` makes an arbitrary GUI process persistent after the tool call: the managed display daemons use a separately detached exec path for that reason. A persistent native GUI launcher needs an application-specific supervisor/daemon or a separately verified detached launcher; this article does not prescribe a generic one. Use a stable app-specific output or CLI/API where possible. Keep logs and generated artifacts under `/workspace` when they need to be transferred; `/tmp` is suitable for diagnostics only.

Do not copy Chromium's container-specific `--no-sandbox` setting to every GUI application. The managed browser and root-owned smoke tests have special launch constraints; `--no-sandbox` weakens a sandbox and is not a universal recommendation. Likewise, a GPU-disabled launch may be a useful experiment-specific workaround, but the repository evidence does not establish a general GPU failure cause or a universal flag set.

### 3. Watch or interact

- A human can use the Studio browser viewer when the managed display is available. The viewer is a noVNC view of the container's X display, so other X clients may be visible on that display as well as Chromium.
- For web content, configure the maintained Playwright MCP server. It attaches to the already-running managed Chromium, preserving the same tabs, cookies, and visible session.
- For a native non-browser app, use its CLI/API or ask the human to operate it in the viewer. A process being alive does not prove that the correct window is visible or that an operation completed.

When a browser site requests sign-in, CAPTCHA, MFA, passkey, or another security review, stop automation and ask the human to take over the visible browser. Do not bypass the challenge or ask automation to handle the human's browser credentials; the human completes the sign-in or security review in the visible browser. Follow the relevant identity or channel guide for other credential setup.

### 4. Validate the actual result

Validate at three levels:

1. **Artifact:** confirm the expected file exists and has a plausible size/type.
2. **Application:** inspect the app's output, log, or API result and check its exit status.
3. **Visible evidence:** use the viewer or the application's own export/screenshot facility when available, transfer the image to the VFS, and inspect the actual image. ADF does not provide a generic native-desktop screenshot operation. Assert the expected title/content and select the intended X client or browser target when more than one full-screen window is present.

Do not claim success from a PID, window-list entry, process metadata, or a successful launch command alone. A screenshot of an old `about:blank` browser tab is not evidence that another application rendered. Keep screenshots as evidence only after inspecting them; do not leave transient PIDs or experiment-specific absolute paths in reusable instructions.

## Lifecycle and persistence

Managed isolated containers are created and started for an agent when isolated compute is enabled. On an agent stop or unload, the agent's compute lifecycle resource calls `stopIsolated`: the dedicated container is **stopped, not removed**, so its filesystem—including installed packages and files under `/workspace`—can be reused on a later start. On orderly application shutdown, runtime teardown disposes the foreground and background agents and then stops remaining managed containers. An explicit rebuild or destroy action removes that state. Application processes and display daemons do not survive a container stop; they must be launched again.

An unclean host or container failure does not guarantee cleanup or durable persistence. The browser profile is stored in the container at `/var/lib/adf/browser-profile`, not automatically inside the `.adf` file; browser persistence therefore follows container lifetime unless the profile-portability procedure is used. Treat cookies and saved passwords in that profile as sensitive.

This persistence is container-local, not a guarantee of durable backup, cross-machine portability, or a complete desktop session. Transfer important inputs and outputs to the VFS or another explicitly managed destination.

## Security and isolation limits

- **Isolated is the least-privileged GUI choice, not a security proof.** It gives an agent-dedicated managed container and workspace rather than host filesystem access, but it is still a runtime/container boundary. Review the image, packages, network, and Podman configuration for your threat model.
- Managed containers use bridge networking. A GUI process can make network requests if its program does so; visible does not mean offline.
- The shared container is not agent-isolated: agents use separate workspace directories but can see the shared container's filesystem according to its permissions, and processes can contend for resources. Use isolated for sensitive or interfering desktop work.
- Managed containers share an npm/npx cache volume. Do not treat every container artifact or cache as a private secret store.
- Host execution is not a safer fallback. It requires both the agent's `compute.host_access` and the runtime's owner-controlled host-access setting, and then runs with the user's OS privileges.
- The noVNC endpoint is published on host loopback, while browser CDP is container-loopback. Do not expose either endpoint or assume that a loopback URL is a public sharing mechanism.

## Evidence and open questions

On 2026-09-05, at baseline repository revision `1347204d2f938c6dcf14db7102ad5dcb0c3b2266`, a Linux x86_64 isolated test environment with outer `DISPLAY=:99` ran ADF Studio in development mode alongside the existing persistent Chromium session. Display inspection showed both visible windows; an explicitly selected Studio Electron target reported title `ADF Studio`, `readyState` `complete`, and non-empty rendered body text, and the resulting screenshot was inspected. Podman was not installed in that outer test environment, so this bounded observation verifies the outer Electron/display path—not managed agent-container GUI compatibility or arbitrary native applications.

Still unverified by this observation: installation and operation of particular PDF/image/editor applications; generic mouse or keyboard automation; drag-and-drop; multi-window focus semantics for every window manager; audio, printing, GPU acceleration, and long-running desktop sessions. Treat each as a new verification task rather than a supported promise.
