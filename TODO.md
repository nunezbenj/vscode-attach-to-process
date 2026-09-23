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

- [ ] Attach to all workers of a multiprocessing job (subProcess) from one pick
- [ ] Localization

## Ideas for run-with-wait (1.3.0 shipped the base)

- [ ] Countdown in the panel row (the marker has `started`/`timeout`; needs the tree to re-fire on a timer)
- [ ] "Re-run last wait command" (remember the last generated command per workspace)
- [ ] Recognize a `.attaching` claim left behind by a window that reloaded mid-injection (offer it again after a grace period)

## Done in 1.3.0

- [x] Run with wait: bundled `waitattach.py`, copy/run commands, marker watcher, auto-attach, claim

## Done in 1.0.0

- [x] Picker, preflight, in-memory config, connect mode, re-attach guard, e2e DAP test
