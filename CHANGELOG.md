# Changelog

## 1.2.2

- Logs are written to a file per session and survive window reloads (last 10 sessions kept);
  **Attach: Open Previous Session Logs** picks one from a crashed session
- *Report a Bug* renamed **Copy Diagnostic Report**; the report includes the log location and
  offers to open the log folder

## 1.2.1

- **Report a Bug…** command: copies environment (versions, interpreter, remote, gdb/ptrace),
  settings and the recent log to the clipboard and opens a prefilled GitHub issue
- Environment summary logged at activation; verbose mode now records the full debug-adapter
  traffic of attach sessions; command failures are logged instead of disappearing
- `attach.debugpyLogToFile` to get debugpy's own logs

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
