---
name: production-artifact-clean-install-qa
description: Test a released desktop or package artifact in a clean environment. Report install-to-use evidence. Do not use secrets or a dev build unless the request says so.
---

# Production Artifact Clean Install QA

## Purpose

Use this skill to test a public release artifact from install to first useful use. The output is a report where every step is marked PASS, FAIL, BLOCKED or NOT RUN, and every mark rests on evidence.

## Use this when

Use it when someone asks for release QA on a packaged artifact, such as:

- a `.deb`, `.AppImage`, `.dmg`, `.exe`, or installer from a public release,
- a clean-install check,
- first-run setup or provider setup,
- proof that the artifact works without a source checkout or dev build.

## Inputs

Get these first:

- target OS, or the OS you can actually test now,
- artifact URL and release version,
- acceptance criteria,
- whether credentials are allowed,
- whether local services can be installed or must already exist,
- whether screenshots or logs are required.

## Procedure

1. State the test boundary.
   - Say which OS you can test.
   - Say whether the environment is a fresh VM, new user profile, container, or only partly clean.

2. Create clean app state without destroying anything.
   - Use a disposable environment you are authorized to use: a throwaway VM, a new OS user, or an isolated home directory.
   - Do not delete or reset existing user state, uninstall an existing production copy of the app, or change shared host services unless the request explicitly authorizes it. If the only available machine already has the app installed, report that and stop. Do not clean it up yourself.
   - On Linux GUI tests, set `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` if needed.
   - An isolated home directory tests fresh app state. It does not make the machine clean. A normal package install still changes system state. Say which of the two you tested.
   - Do not reuse old app settings.

3. Download only the production artifact.
   - Use the release asset URL.
   - Record filename, size, and SHA256.
   - Do not inspect source `main` unless the request asks for source comparison.
   - Do not build from source.

4. Install the artifact.
   - Use the normal install command for that OS.
   - Capture package metadata and install logs.
   - Stop at the first hard blocker if install fails.

5. Launch the installed app.
   - Launch as a normal user when possible.
   - If a GUI needs a headless display, use Xvfb or the runtime display and say so.
   - Capture stdout, stderr, window evidence, and any local health endpoint.

6. Perform first-run setup.
   - Follow the visible UI.
   - Use a non-secret local option only if it already exists or the request permits installing one.
   - Do not use credentials or paste secrets unless the request allows it.
   - Permission to use credentials does not mean permission to get past security checks. If you hit a sign-in, CAPTCHA, MFA, passkey or similar interactive check, stop. Ask the principal to complete it on the approved surface. Do not automate around it.
   - Permission to use credentials does not skip the normal tool or OS approval steps.
   - Keep credentials out of screenshots, logs and shared evidence. Redact before you share anything.
   - If setup is blocked because no local model server or API key exists, call it a prerequisite blocker unless the app promised to supply that prerequisite.

7. Create or open one item and get one useful response if possible.
   - For ADF Studio, create or open one `.adf`, select a configured provider, send one simple prompt, and record the response.
   - If blocked before this step, report the exact blocker. Do not claim install-to-use success.

8. Preserve evidence.
   - Keep screenshots small enough to attach.
   - Save important logs and command output.
   - Record exact visible copy if the issue is UX or setup copy.

## Output

Return a short report with:

- OS and version,
- exact asset URL and filename,
- SHA256,
- whether the environment was clean,
- completed steps,
- blocker or error evidence,
- workaround attempted,
- a status for each step, using these meanings:
  - `PASS`: the criterion was observed to be met.
  - `FAIL`: an acceptance criterion was observed not to be met. Name that criterion.
  - `BLOCKED`: the step could not run because something outside the app was missing or not permitted, such as a provider, credential or service.
  - `NOT RUN`: the step was skipped or never reached.
  - Example: `install: PASS`, `launch: PASS`, `first-use: BLOCKED (no permitted model provider)`. That is not an app failure.
  - Report `install-to-use: PASS` only when every step passed.
- confidence level,
- screenshots or logs if useful.

## Validation

Before you report success, verify that:

- the artifact came from the requested release,
- the app was not a dev build,
- app state was new, or the cleanliness limits are stated,
- install evidence exists,
- launch evidence exists,
- setup evidence exists,
- one useful response exists if the task requires install-to-use success,
- every FAIL names the acceptance criterion it missed, and every BLOCKED or NOT RUN names the missing prerequisite or the reason the step was skipped,
- no credentials appear in any evidence you share.

## Boundaries

- Do not use private API keys unless the request allows it.
- Do not install a model server unless the task allows it.
- Do not mutate public repos for a QA-only request.
- Do not hide environment limits. If a container, WSL, Xvfb, missing DBus, root sandbox limits, or missing Podman affects the test, say it.
- Do not turn a prerequisite gap into an app defect unless the UI or docs promised that the app supplies the prerequisite.
