# Changelog

## 1.0.0

Initial release.

- Process picker listing the current user's Python processes (script, args, cwd, PID, age), newest first
- In-memory `debugpy` attach configuration — no `launch.json`
- Preflight for `gdb` and `kernel.yama.ptrace_scope` with copyable one-line fixes
- Recognizes scripts launched with `python -m debugpy --listen` and connects instead of injecting
- Connect to host:port, copy debug-ready launch command, check server readiness, show log
- Warns before re-attaching to a process that was already injected once (debugpy limitation)
- Status-bar button, `Ctrl+Alt+A`, Run and Debug view button and welcome link
