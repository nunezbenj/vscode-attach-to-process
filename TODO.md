# TODO / Roadmap

Working notes for development. Not packaged in the VSIX (see `.vscodeignore`).

## Next

- [ ] Detect processes that already have an injected debugpy listener (via /proc/net/tcp
      inode → pid) and connect to them instead of re-injecting
- [ ] Remember the last picked script per workspace and offer it first ("Re-attach to…")
- [ ] Optional: `attach.pythonPath` override for the injector (currently the interpreter
      selected in the Python extension runs the adapter, which does the injection)
- [ ] Show process owner/tty in detail; optional listing of other users' processes when
      running as root
- [ ] Windows host support (WMI/PowerShell process listing; debugpy injection works there)

## Ideas

- [ ] One-click "run this file debug-ready in a terminal" (`python -m debugpy --listen`)
- [ ] Attach to all workers of a multiprocessing job (subProcess) from one pick
- [ ] Localization

## Done in 1.0.0

- [x] Picker, preflight, in-memory config, connect mode, re-attach guard, e2e DAP test
