# Visible Browser

Each agent with isolated compute and browser support enabled has one ADF-managed visible Chromium session. Studio streams that display through noVNC so the user can watch and interact while the agent automates the same browser.

## Lifecycle and ownership

ADF starts the display server, window manager, noVNC bridge, and Chromium in the agent's isolated Podman container. Studio waits for the noVNC endpoint before opening the viewer, avoiding transient `ERR_EMPTY_RESPONSE` failures during container startup.

Chromium uses a persistent profile at `/var/lib/adf/browser-profile`. The profile survives browser and MCP restarts while the container exists. Chromium uses its portable basic password store, so its ordinary saved-password database remains part of this sensitive profile instead of depending on a host OS keychain. ADF reconciles existing containers on startup so containers created by older versions receive required browser packages, fonts, timezone data, compatibility support, and managed-browser configuration.

The browser runtime accounts for host and Podman architecture differences across Apple Silicon and Intel macOS, Intel and AMD Windows, and Intel and AMD Linux. A renderer probe runs before the visible browser is considered ready; a failing native Chromium runtime is repaired or reported instead of producing a delayed `SIGILL` crash page.

## Automation

ADF owns Chromium. Browser automation servers attach to its loopback Chrome DevTools Protocol endpoint rather than launching another browser. Use the maintained `@playwright/mcp` integration. This provides one shared source of truth for tabs, cookies, storage, login state, and the visible viewer.

The agent should call `mcp_restart` after restoring a browser profile or when an MCP connection was established before Chromium became ready.

## Login and security reviews

The persistent profile, host-consistent timezone and locale, installed fonts, and visible non-headless browser reduce needless fresh-device challenges. They cannot eliminate risk checks based on IP reputation, VPN use, CDP detection, account history, or a site's own fraud controls.

When a site presents login, CAPTCHA, MFA, passkey, device verification, or another security review, the agent pauses automation and asks the user to take over the visible browser. It resumes only after the user confirms completion. Agents must not bypass security challenges or request credentials in chat.

## Moving a profile with an agent

The container profile is not automatically embedded in the `.adf` file. Use the repository's `browser-profile-portability` skill to checkpoint it into encrypted `adf_identity` entries and restore it into another isolated container.

The portable snapshot retains cookies, saved passwords, login databases, local storage, preferences, history, and extensions. Only disposable caches, crash artifacts, metrics, logs, and live lock/socket files are excluded. The skill encrypts the archive before it crosses `fs_transfer`, uses verified A/B snapshot slots, validates Chromium compatibility and archive integrity, and performs rollback-safe replacement. Passwords are intentionally retained: this is what lets a moved agent resume its sessions without signing in again. Hardware-backed or device-bound passkeys, enterprise policies, extensions, and a site's fraud controls may still require user verification.

The skill creates a snapshot only when the ADF credentials envelope is protected and unlocked. Because the snapshot lives in that envelope, sharing it follows the normal [Security and Identity](security-and-identity.md) share-password and claim flow. Anyone who is deliberately given the credentials envelope and unlocks it receives the browser sessions and saved passwords it contains; rotate upstream sessions if that access must later be revoked.
