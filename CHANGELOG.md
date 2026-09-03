# Changelog

## 1.2.0

- **Stop Process**: red stop button on the debug toolbar (for attach sessions) and on every row of
  the Attach panel — disconnects, sends SIGTERM, and offers SIGKILL if the process is still alive
  after 5 s. Asks for confirmation first.

## 1.1.2

- Reveal the Debug Console when an attach session starts (`attach.debugConsole`, default
  `openOnSessionStart`), so you're not left looking at the Terminal tab

## 1.1.1

- Report the real attach outcome: rows show *injecting debugpy…* until debugpy inside the
  process has connected, then *attached · N threads*; failures show why
- Progress notification while injecting, with a hint (and Cancel) if it takes more than 15 s
- Status-bar confirmation with the thread count once attached

## 1.1.0

- **Attach** panel in the activity bar (the plug icon on the left): lists your running Python
  processes with an inline attach button, refreshes itself while visible, shows attached state,
  and offers Copy Command Line / Copy PID on right-click

## 1.0.1

- Plug icon in the editor title bar next to the Run/Debug button (Python files), an entry in
  that button's dropdown, and a button on the floating debug toolbar

## 1.0.0

Initial release.

- Process picker listing the current user's Python processes (script, args, cwd, PID, age), newest first
- In-memory `debugpy` attach configuration — no `launch.json`
- Preflight for `gdb` and `kernel.yama.ptrace_scope` with copyable one-line fixes
- Recognizes scripts launched with `python -m debugpy --listen` and connects instead of injecting
- Connect to host:port, copy debug-ready launch command, check server readiness, show log
- Warns before re-attaching to a process that was already injected once (debugpy limitation)
- Status-bar button, `Ctrl+Alt+A`, Run and Debug view button and welcome link
