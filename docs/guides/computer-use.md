---
type: guide
description: How an agent drives its own desktop — look at the screen, click, type, open apps and files, share the screen with its principal — using compute_exec, fs_transfer, xdotool, scrot and xclip
see_also:
  - browser.md — the managed Chromium on the same desktop, Playwright automation, sign-in handoff
  - compute.md — enabling the isolated container the desktop runs in, approvals for compute_exec
  - documents-and-files.md — the VFS and fs_transfer
  - ../knowledge/desktop-apps.md — recipe for a native application end to end
---

# Computer Use

Your isolated container has a real Linux desktop (X display `:99`): a panel with an application menu, a file manager, a terminal, a text editor, and the managed Chromium. Your principal sees the same screen in the **Computer** tab. Everything below runs through `compute_exec` on the isolated target; `DISPLAY` is already set for you.

## The loop: look, act, look again

Desktop control is coordinate based, so every action is a three-step loop. Screenshot, look at the image, act; then screenshot again to see what happened.

```text
compute_exec({ command: "scrot -o /workspace/shots/1.png", target: "isolated" })
fs_transfer({ from: "isolated", to: "vfs", path: "shots/1.png", save_as: "shots/1.png" })
→ open shots/1.png and read the screen
compute_exec({ command: "xdotool mousemove 412 233 click 1", target: "isolated" })
compute_exec({ command: "scrot -o /workspace/shots/2.png", target: "isolated" })
```

The desktop is exactly the size of the Computer tab, so coordinates from an old screenshot go stale when your principal resizes the window. `xdotool getdisplaygeometry` tells you the current size; if it changed, take a fresh screenshot before clicking.

## Seeing what is there without a screenshot

Window titles are cheap and often enough:

```text
xdotool search --onlyvisible --name '' getwindowname %@        # every visible window
xdotool getactivewindow getwindowname                           # what has focus
xdotool search --onlyvisible --name 'Sign in' getwindowgeometry # where a window is
```

A process being alive is not evidence that its window is showing. When it matters, look.

## Acting

```text
xdotool mousemove 640 400 click 1          # left click (3 = right, 4/5 = scroll up/down)
xdotool mousemove 100 100 mousedown 1 mousemove 500 300 mouseup 1   # drag
xdotool type --delay 20 'hello'            # type text (ASCII)
xdotool key ctrl+l                         # key chords
xdotool key Return  |  key Escape  |  key alt+F4  |  key alt+Tab
xdotool search --onlyvisible --name 'Mousepad' windowactivate --sync   # focus a window first
```

For long text, or anything beyond ASCII, go through the clipboard instead of `type`:

```text
printf '%s' "$TEXT" | xclip -selection clipboard && xdotool key ctrl+v
```

Reading the clipboard back is `xclip -selection clipboard -o`.

## Opening applications

The panel launchers are also commands, and `setsid -f` is what lets a GUI program outlive the one-shot `compute_exec` that started it:

```text
adf-browser start https://example.com                       # the managed browser (returns once it is up)
setsid -f lxterminal --working-directory=/workspace </dev/null >/dev/null 2>&1
setsid -f mousepad /workspace/notes.md </dev/null >/dev/null 2>&1
setsid -f pcmanfm /workspace </dev/null >/dev/null 2>&1
```

Anything else the task needs can be installed with `apt-get install`; it appears in the application menu by itself. Whether that command runs without approval depends on your compute policy (see [Compute Environments](compute.md)).

## Files

The desktop's working folder is `/workspace`. It is not the VFS: move inputs in and results out with `fs_transfer`, and check the result before relying on it. Images, PDFs and HTML open in the managed browser, so viewing a rendered file is one command:

```text
adf-browser start file:///workspace/report.pdf
```

## Browser versus desktop

For web pages use the Playwright MCP server: it reads the DOM and needs no coordinates. Reach for `xdotool` when the DOM does not cover it — a native file chooser, a print dialog, a popup window you cannot address, another application. A file chooser is usually just a path and Return:

```text
xdotool search --onlyvisible --name 'Open File' windowactivate --sync key ctrl+l type '/workspace/inputs/photo.png'
xdotool key Return
```

The browser opens on demand and stays closed once closed. If a browser tool fails because it is gone, `adf-browser status` tells you; restarting the browser MCP server (`mcp_restart`) or `adf-browser start` brings it back.

## Sharing the screen

It is one desktop, and your principal's mouse is the same mouse. Say when you are about to drive, and stop driving while they are. Sign-in, CAPTCHA, MFA, passkeys and other security checks are theirs: ask them to take over in the Computer tab and resume only after they say it is done. Never type their credentials.

## What to trust

Trust screenshots and application output, not launch commands. A successful `xdotool` exit code means the event was sent, not that the application did anything with it. Audio, printing and GPU acceleration are not part of this desktop.
