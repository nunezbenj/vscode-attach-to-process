[![License](https://img.shields.io/github/license/nunezbenj/vscode-attach-to-process)](LICENSE)

# Python: Attach to Running Process

Attach the VS Code Python debugger to a **script that is already running** — from a picker, with no `launch.json`.

1. Set your breakpoints in VS Code.
2. Run the script from wherever you like: the integrated terminal, a plain SSH session, `tmux`, a cron job.
3. Press `Ctrl+Alt+A` (or click **Attach** in the status bar), pick the process, done. Your breakpoints are live.

Same effect as adding an attach entry to `.vscode/launch.json` and launching from the IDE, minus the ceremony.

## Why

VS Code can already attach to a running Python process (debugpy injects itself by PID), but the workflow buries it: edit `launch.json`, pick from a raw process list, hope you grabbed the right one. Most people never find out it exists. This extension turns it into one keystroke and a list of *your* Python processes, showing the script, its arguments, working directory and how long it has been running.

It pairs well with [PyCharm-like Evaluate Expression](https://marketplace.visualstudio.com/items?itemName=nunezbenj.pycharm-evaluate): attach with one, inspect with the other.

## Features

- **Attach panel** — a plug icon in the activity bar opens a view of your running Python processes; one click on a row attaches. It refreshes itself while visible and shows which processes are already attached.
- **Process picker** — lists the current user's Python processes, newest first, with script (relative to its cwd), arguments, PID and age. Editor tooling (debugpy adapters, VS Code Server helpers, language servers) is hidden by default; toggle it with the eye button.
- **No launch.json** — the attach configuration is built in memory for the session and never written to disk.
- **Remote-native** — the extension runs on the remote host under Remote-SSH, so it sees the processes on the server you're connected to.
- **Preflight with fixes** — checks that `gdb` is installed and `kernel.yama.ptrace_scope` allows attaching, and shows the one-line fix instead of debugpy's traceback wall.
- **Debug-ready processes** — scripts launched with `python -m debugpy --listen …` are recognized (marked *listening*) and connected to directly instead of injected. There is also a manual **Connect to host:port** command and a **Copy debug-ready launch command** helper for hosts where injection isn't possible.
- **Stop Process** — VS Code only offers *Disconnect* for attached sessions. The stop button on the toolbar and in the panel disconnects and terminates the process, with confirmation and a force-kill fallback.
- **Re-attach guard** — warns when you pick a process that was already attached once in this window (see Limitations).

## Requirements

- The [Python Debugger](https://marketplace.visualstudio.com/items?itemName=ms-python.debugpy) extension (installed automatically as a dependency) with a Python interpreter selected.
- A **Linux** (or macOS) host for attach-by-PID. On Linux, injection uses `gdb` and needs ptrace permission:

  ```bash
  sudo apt install -y gdb
  echo 'kernel.yama.ptrace_scope = 0' | sudo tee /etc/sysctl.d/10-ptrace.conf && sudo sysctl --system
  ```

  Scope 0 still limits ptrace to your own processes (plus root); it does not let users inspect each other's programs. No reboot needed. Run **Attach: Check Server Readiness** to verify a host.

- Windows laptops are fine as the *client*: open your Linux server with Remote-SSH and the extension does its work there. Attaching to processes on the Windows machine itself is not supported.

## Usage

| Action | How |
| --- | --- |
| Attach to a running process | The **plug icon in the activity bar** (left), the plug icon next to the Run/Debug button in the editor title bar (Python files), `Ctrl+Alt+A`, the **Attach** status-bar item, the plug on the debug toolbar, or Command Palette → *Attach: Attach to Running Python Process…* |
| Stop a process (like the red Stop button) | The stop button on the debug toolbar, or on any row in the Attach panel — disconnects, sends SIGTERM, offers SIGKILL if needed |
| Refresh / show tooling processes | Buttons in the picker's title bar |
| Connect to a script started with `--listen` | Pick it in the list (marked *listening*), or *Attach: Connect to Listening debugpy (host:port)…* |
| Verify a server | *Attach: Check Server Readiness (gdb, ptrace)* |
| Troubleshoot | *Attach: Show Log*; for bugs, *Attach: Report a Bug…* copies environment + settings + recent log and opens a prefilled GitHub issue |

Try it with the bundled sample: run `python3 test-python/sleeper.py --tag demo` in a terminal, put a breakpoint on the `total += n` line, press `Ctrl+Alt+A` and pick `sleeper.py --tag demo`.

### The guaranteed path (no gdb, no ptrace)

On a host you don't administer, launch the script debug-ready and connect instead of injecting:

```bash
python -m debugpy --listen 5678 --wait-for-client your_script.py --your args
```

The picker shows it as *listening :5678* and connects on selection. This mode also supports disconnecting and reconnecting as often as you like.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `attach.justMyCode` | `true` | Set to `false` to step into library/framework code |
| `attach.processFilter` | `""` | Regex on the full command line; only matches are listed |
| `attach.showHiddenProcesses` | `false` | List editor tooling too |
| `attach.defaultHost` / `attach.defaultPort` | `localhost` / `5678` | Defaults for *Connect* and the copied launch command |
| `attach.pathMappings` | `[]` | debugpy `pathMappings` for every attach (not needed under Remote-SSH) |
| `attach.subProcess` | `false` | Debug child processes spawned after attaching |
| `attach.extraConfig` | `{}` | Extra keys merged into the generated configuration |
| `attach.debugConsole` | `openOnSessionStart` | Reveal the Debug Console when an attach starts (`neverOpen` to leave the panel alone) |
| `attach.showStatusBarItem` | `true` | Show the status-bar button |
| `attach.debugpyLogToFile` | `false` | Have debugpy write its own logs (adapter, injector, in-process server) |
| `attach.verboseLogging` | `false` | Log every process considered, why it was hidden, and the full debug-adapter traffic |

## Limitations

- **Attach is not time travel.** Breakpoints bind when you attach; code that already ran is gone. Great for long-running loops, servers and test runners; for a script that finishes in a second, use `--listen --wait-for-client`.
- **One injection per process.** After you disconnect from a process attached by PID, debugpy cannot cleanly attach to it again (a second injection reports success but breakpoints never hit). Restart the script, or use the `--listen` path, which supports reconnecting. The picker warns you about this.
- Processes belonging to other users are never listed (and could not be attached to anyway).

## Troubleshooting

- *"Did it attach?"* — the row in the Attach panel (and the status bar) says *attached · N threads* once debugpy inside the process has connected; the Debug Console's "Attaching to PID… (elapsed …)" lines stop at that moment. Open **Run and Debug → Call Stack** to see the threads.
- *"Pause does nothing"* — Pause only stops threads that are executing Python code. A thread blocked in a native call (`Thread.join`, a lock, a socket read without timeout, `subprocess.wait`) shows up as paused only when it returns to Python. A breakpoint on a line the program keeps hitting is the reliable way in; the Call Stack view still lists the threads either way.

- *"gdb is not installed"* / *"ptrace_scope is 1"* — apply the commands from **Requirements**, then retry. The messages offer to copy the fix.
- *"did not start"* — the Debug Console shows debugpy's own output. A process that exited between listing and attaching, or a Python interpreter not selected in the Python extension, are the usual causes.
- The `frozen modules` warning debugpy prints is benign for your code.
- **Filing a bug**: turn on `attach.verboseLogging` (and `attach.debugpyLogToFile` for injection problems), reproduce, then run *Attach: Report a Bug…* — it copies the environment, settings and recent log to your clipboard and opens a prefilled issue. Skim the bundle for hostnames or paths you'd rather not share before posting.

## Development

```bash
npm install
npm run compile
npm test                       # unit tests + live /proc discovery
python3 test-python/e2e_attach.py   # full injection round trip via DAP (needs gdb + ptrace)
```

Press F5 in VS Code to run the extension in an Extension Development Host.

## License

MIT
