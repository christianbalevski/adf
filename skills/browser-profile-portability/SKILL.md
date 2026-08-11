---
name: browser-profile-portability
description: Securely checkpoint, carry, verify, and restore an ADF agent's persistent Chromium profile across isolated containers. Use when browser cookies, saved passwords, logins, history, local storage, extensions, or other session state must survive container replacement or travel with the agent's .adf file.
adf: ">=0.2"
requires:
  tools: [sys_code, compute_exec, fs_transfer, fs_read, fs_write, fs_delete, fs_list]
  config: [compute.enabled, code_execution.identity_status, code_execution.get_identity, code_execution.set_identity]
---

# Browser Profile Portability

Carry the agent's complete useful browser identity without exposing profile bytes, credentials, or encryption keys to the model loop, command history, logs, or plaintext ADF files. Inspect the live environment and adapt commands and paths; do not assume a particular host architecture.

## Preserve these invariants

- Keep login-bearing data, including cookies, `Login Data`, `Local State`, saved passwords, site storage, history, preferences, and extensions.
- Exclude only disposable caches, crash reports, browser metrics, transient logs, `DevToolsActivePort`, and `Singleton*` lock/socket files.
- Stop Chromium cleanly and verify that no process is using the profile before archiving or replacing it. Never archive live SQLite databases.
- Use `adf_identity` only after confirming that the **credentials envelope is protected and unlocked**. For a transfer to a different owner, require a share-password slot. `set_identity` is not encrypted in an unprotected legacy file.
- Never put a plaintext profile archive or plaintext data-encryption key in `adf_files`, a shell-command argument, stdout/stderr, a returned value, or a log.
- Verify size, chunk count, format version, and SHA-256 before changing the active profile.
- Preserve the last working snapshot until the replacement has been stored and read back successfully.
- Restore only into a compatible Chromium version. Never restore a profile created by a newer Chromium major into an older major.
- Return only small status metadata. Never return archive chunks, cookies, credentials, or keys.

## Preflight the environment

1. Inspect agent configuration and enabled tools. Require `get_identity`, `set_identity`, `fs_transfer`, and isolated `compute_exec` access.
2. Determine whether `compute_exec` is unrestricted. Call it directly from code when it is unrestricted for this isolated container; use an owner-authorized lambda only when it is actually restricted.
3. Call `adf.identity_status({})` and require `envelopes.credentials === 'unlocked'`. Then write and list a harmless `browser:profile:v1` probe to verify it is reported as encrypted before writing profile material. Before moving the `.adf` to another owner or environment without the same owner identity, require and test a credentials share password. Do not create a snapshot in an absent, foreign, locked, or legacy plaintext credentials store.
4. Discover the managed Chromium command line, profile directory, executable, version, CDP port, and process owner. The current ADF default is `/var/lib/adf/browser-profile`, but discovery is authoritative.
5. Confirm that Node.js and its standard `crypto` module are available in both the code sandbox and container. Use standard RSA-OAEP/SHA-256 and AES-256-GCM primitives; do not invent encryption.
6. Abort before navigation if a restore is required. If Chromium is already running, stop it before replacing the profile and restart it afterward.

If the environment cannot transfer an encrypted archive without exposing its key or plaintext, stop and explain the missing capability. Do not silently downgrade to plaintext staging.

## Use the storage format

Maintain two reusable snapshot slots, `a` and `b`, plus an active pointer:

- `browser:profile:v1:active`
- `browser:profile:v1:<slot>:manifest`
- `browser:profile:v1:<slot>:dek`
- `browser:profile:v1:<slot>:chunk:<zero-padded-index>`

Store JSON in each manifest with: schema version, slot, archive format, cipher, Chromium major and full version, profile path, created time, plaintext and ciphertext sizes, ciphertext SHA-256, chunk size, chunk count, and excluded path patterns. Store ciphertext chunks as base64 strings. Keep chunk payloads modest enough for code execution and identity calls.

Always write the inactive slot, verify it by reading every value back, and update `browser:profile:v1:active` last. A failed checkpoint must leave the previous active slot restorable. Extra chunks left from an older generation are ignored because the manifest defines the authoritative count.

## Checkpoint the profile

1. Create a private transfer directory under `/workspace` in the isolated container and install a cleanup trap. `fs_transfer` addresses only that container workspace; keep the plaintext archive there only until it is encrypted and deleted.
2. Close Chromium gracefully, wait for exit, and remove only transient lock/socket files after exit.
3. Archive the profile while retaining login and password data. Exclude disposable caches and crash artifacts only.
4. Generate a random 256-bit data-encryption key in sandbox code.
5. Establish an ephemeral public-key bridge so the raw key never appears in `compute_exec` arguments or output:
   - Generate an ephemeral RSA keypair inside the container.
   - Return only the public key.
   - Wrap the data key with RSA-OAEP/SHA-256 in sandbox code.
   - Pass only the wrapped key to a container helper.
   - Decrypt the wrapped key in container memory, encrypt the archive with AES-256-GCM and a fresh nonce, then delete the ephemeral private key and plaintext archive.
6. Split authenticated ciphertext into bounded files before using `fs_transfer`; transfer only those ciphertext files. Read and store each chunk from code without returning it. Do not send a whole profile archive through `compute_exec` output.
7. Store the ciphertext chunks, data key, and manifest in the inactive `adf_identity` slot.
8. Read the complete inactive slot back, reconstruct it in code, and verify its ciphertext digest and manifest before flipping the active pointer.
9. Delete transfer files from VFS and the container. Ciphertext remnants are acceptable; plaintext and keys are not.
10. Restart ADF-managed Chromium and restart the browser MCP. Verify CDP and a simple page before reporting success.

## Restore the profile

1. Read the active pointer, manifest, data key, and exact manifest-declared chunk set entirely inside code.
2. Reconstruct the ciphertext and verify its size and SHA-256 before stopping Chromium or modifying the current profile.
3. Recreate bounded ciphertext files and transfer only ciphertext to the isolated container.
4. Use a new ephemeral container RSA keypair to wrap the stored data key across the code/container boundary. Never place the raw key in a command.
5. Decrypt and authenticate into a private staging directory. Validate every archive member first; reject authentication failure, absolute paths, `..` traversal, and links that escape staging. Extract without preserving archive ownership or permissions, and reject an incompatible Chromium major.
6. Stop Chromium and verify exit. Rename the current profile to a rollback directory, atomically move the staged profile into place, and correct ownership and permissions.
7. Remove stale runtime lock files, restart managed Chromium, restart the browser MCP, and verify CDP plus expected profile metadata.
8. Restore the rollback directory if launch, CDP, or profile validation fails. Delete the rollback only after successful verification.

## Handle authentication safely

Preserved login state is the purpose of this skill. Do not discard password databases merely because they are sensitive; protect them with the encrypted archive and ADF credentials envelope. ADF's managed Chromium uses its portable basic password store, so ordinary saved-password entries are expected to travel with the profile. Hardware-backed or device-bound passkeys, enterprise policies, extensions, and site risk controls can still prevent reuse. If a site requests CAPTCHA, MFA, passkey, device verification, or a security review, pause and ask the user to take over the visible browser. Never attempt to bypass the challenge or request credentials in chat.
