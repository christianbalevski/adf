---
type: guide
description: The Computer tab — each isolated agent's visible desktop with a managed Chromium session, IceWM window management, computer-use CLI tools, user takeover for security checks, and portable browser profiles
see_also:
  - compute.md — enabling the isolated container the desktop runs in
  - ../knowledge/desktop-apps.md — running other GUI applications on the same desktop
---

# Computer (Visible Desktop and Browser)

Each agent with isolated compute and desktop support enabled has a visible Linux desktop inside its container. Studio streams that display through noVNC into the agent's **Computer** tab, so the user can watch and interact while the agent automates the same screen. The desktop runs one ADF-managed Chromium session by default; anything else the agent launches with a display renders there too.

## Prerequisites

- `compute.enabled: true` — the isolated container the desktop runs in (see [Compute Environments](compute.md))
- `compute.browser: true` (the default) — the display stack (X server, IceWM, noVNC) and managed Chromium; `false` means headless-only with no Computer tab

Both are agent-writable via `sys_update_config` (HIL-gated: your principal approves). Browser automation additionally uses an `mcp.servers[]` entry for `@playwright/mcp` — installable via `mcp_install`, which is disabled by default (`tools.mcp_install.enabled` to request). See [MCP Integration](mcp-integration.md).

## What is on the desktop

- **Window manager: IceWM.** Every window has a titlebar with a close button and an entry on the taskbar at the bottom of the screen. Popup windows (OAuth sign-in, print dialogs, a second browser window) open as their own windows: close them with the titlebar button or `Alt+F4`, and switch between windows with the taskbar or `Alt+Tab`. The start menu at the left of the taskbar lists installed applications.
- **Managed Chromium**, started maximized with a persistent profile and a loopback CDP endpoint (see below).
- **Computer-use CLI tools** for `compute_exec`: `xdotool` (mouse, keyboard, window focus), `scrot` (screenshot to a file), `xclip` (clipboard), and `xterm` (a terminal on the desktop). See [Driving the desktop from a tool call](#driving-the-desktop-from-a-tool-call).

The desktop resizes to fit the Computer tab exactly; maximized windows follow. The stack is brought up lazily the first time it is needed and restarted automatically when a container comes back. Containers provisioned by older Studio versions receive the desktop packages on their next stack start.

## Lifecycle and ownership

ADF starts the display server, window manager, noVNC bridge, and Chromium in the agent's isolated Podman container. Studio waits for the noVNC endpoint before opening the viewer, avoiding transient `ERR_EMPTY_RESPONSE` failures during container startup.

Chromium uses a persistent profile at `/var/lib/adf/browser-profile`. The profile survives browser and MCP restarts while the container exists. Chromium uses its portable basic password store, so its ordinary saved-password database remains part of this sensitive profile instead of depending on a host OS keychain. ADF reconciles existing containers on startup so containers created by older versions receive required packages, fonts, timezone data, compatibility support, and managed-browser configuration.

The browser runtime accounts for host and Podman architecture differences across Apple Silicon and Intel macOS, Intel and AMD Windows, and Intel and AMD Linux. A renderer probe runs before the visible browser is considered ready; a failing native Chromium runtime is repaired or reported instead of producing a delayed `SIGILL` crash page.

## Browser automation

ADF owns Chromium. Browser automation servers attach to its loopback Chrome DevTools Protocol endpoint rather than launching another browser. Use the maintained `@playwright/mcp` integration. This provides one shared source of truth for tabs, cookies, storage, login state, and the visible viewer.

The agent should call `mcp_restart` after restoring a browser profile or when an MCP connection was established before Chromium became ready.

## Driving the desktop from a tool call

For anything that is not a web page — a native application, a browser popup the automation cannot reach, a file dialog — the agent uses the computer-use CLI tools through `compute_exec` on the isolated target. `DISPLAY=:99` is already set for managed-container processes.

```text
compute_exec({
  command: "scrot -o /workspace/shots/desktop.png && xdotool search --onlyvisible --name '' getwindowname %@",
  target: "isolated"
})
```

Then `fs_transfer` the screenshot to the VFS and look at it before acting. Act with `xdotool`:

```text
compute_exec({
  command: "xdotool search --onlyvisible --name 'Sign in' windowactivate --sync key ctrl+l type 'https://example.com'; xdotool key Return",
  target: "isolated"
})
```

Useful verbs: `xdotool mousemove X Y click 1`, `xdotool type 'text'`, `xdotool key ctrl+w`, `xdotool key alt+F4` (close the focused window), `xdotool search --onlyvisible --name PATTERN windowactivate`. `xclip -selection clipboard` reads or writes the desktop clipboard. Coordinates are in desktop pixels; take a fresh screenshot after each action that changes the screen, and check the result instead of trusting the exit status. `compute_exec` is a one-shot exec, so a GUI process launched from it should be started through a detached supervisor if it must outlive the call; see [Desktop Applications](../knowledge/desktop-apps.md).

Prefer the Playwright MCP server for web content: it sees the DOM and does not need coordinates. Use `xdotool` for what the DOM does not cover.

## Login and security reviews

The persistent profile, host-consistent timezone and locale, installed fonts, and visible non-headless browser reduce needless fresh-device challenges. They cannot eliminate risk checks based on IP reputation, VPN use, CDP detection, account history, or a site's own fraud controls.

When a site presents login, CAPTCHA, MFA, passkey, device verification, or another security review, the agent pauses automation and asks the user to take over in the Computer tab. It resumes only after the user confirms completion. Agents must not bypass security challenges or request credentials in chat. Sign-in flows that open a popup window work like any other window on the desktop: the user completes them in the popup and closes it, or it closes itself.

## Moving a profile with an agent

The container profile is not automatically embedded in the `.adf` file. Use the repository's `browser-profile-portability` skill to checkpoint it into encrypted `adf_identity` entries and restore it into another isolated container.

The portable snapshot retains cookies, saved passwords, login databases, local storage, preferences, history, and extensions. Only disposable caches, crash artifacts, metrics, logs, and live lock/socket files are excluded. The skill encrypts the archive before it crosses `fs_transfer`, uses verified A/B snapshot slots, validates Chromium compatibility and archive integrity, and performs rollback-safe replacement. Passwords are intentionally retained: this is what lets a moved agent resume its sessions without signing in again. Hardware-backed or device-bound passkeys, enterprise policies, extensions, and a site's fraud controls may still require user verification.

The skill creates a snapshot only when the ADF credentials envelope is protected and unlocked. Because the snapshot lives in that envelope, sharing it follows the normal [Security and Identity](security-and-identity.md) share-password and claim flow. Anyone who is deliberately given the credentials envelope and unlocks it receives the browser sessions and saved passwords it contains; rotate upstream sessions if that access must later be revoked.
