#!/usr/bin/env python3
"""Run a script or module, but wait for a debugger to attach first.

    python waitattach.py [-t SECONDS] script.py [args...]
    python waitattach.py [-t SECONDS] -m module [args...]        e.g. -m pytest tests/test_x.py

Prints its PID and pauses. It continues as soon as a debugger client is connected, or after
SECONDS (default 60; 0 = wait forever) if nobody attaches. The program then runs with the
same sys.argv and sys.path[0] it would have had without the wrapper. Nothing is added to the
program being debugged, and no launch.json is needed.

Meant for runs that finish before you could find them in a process list: pytest files, quick
scripts, one-off tools. Long-running programs don't need it; attach to them directly.

While waiting, a marker file is kept in <tmpdir>/waitattach-<uid>/<pid> so that the
"Python: Attach to Running Process" VS Code extension can notice the process and attach to
it automatically (or offer to). The marker is removed when the wait ends. Only the
standard library is used; keep the file name `waitattach.py` so the extension recognizes it.
"""
import json
import os
import runpy
import signal
import sys
import tempfile
import time

DEFAULT_TIMEOUT = 60.0
POLL_S = 0.2       # sleeping releases the GIL, which the debugpy injection needs
GRACE_S = 1.0      # let the client finish sending its breakpoints before the program starts


def log(msg):
    sys.stderr.write('[waitattach] %s\n' % msg)
    sys.stderr.flush()


def debugger_attached():
    debugpy = sys.modules.get('debugpy')            # present once 'debugpy --pid' has injected itself
    if debugpy is not None:
        try:
            return bool(debugpy.is_client_connected())
        except Exception:
            pass
    return sys.gettrace() is not None               # other debuggers / older Pythons


# --- marker file -----------------------------------------------------------------------------

def marker_dir():
    uid = os.getuid() if hasattr(os, 'getuid') else 'user'
    return os.path.join(tempfile.gettempdir(), 'waitattach-%s' % uid)


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True                                 # exists but not ours (EPERM)


def prune_stale_markers(d):
    """Drop markers of processes that no longer exist (a helper that was SIGKILLed while waiting)."""
    try:
        names = os.listdir(d)
    except OSError:
        return
    for name in names:
        pid_s = name.split('.', 1)[0]
        if pid_s.isdigit() and not _pid_alive(int(pid_s)):
            try:
                os.unlink(os.path.join(d, name))
            except OSError:
                pass


class Marker(object):
    def __init__(self, timeout, args):
        self.dir = marker_dir()
        self.path = os.path.join(self.dir, str(os.getpid()))
        self.timeout = timeout
        self.args = args
        self.written = False

    def write(self):
        try:
            os.makedirs(self.dir, mode=0o700, exist_ok=True)
            prune_stale_markers(self.dir)
            body = {'pid': os.getpid(), 'started': time.time(), 'timeout': self.timeout,
                    'cwd': os.getcwd(), 'argv': self.args, 'exe': sys.executable}
            tmp = self.path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(body, f)
            os.replace(tmp, self.path)              # appears atomically, complete
            self.written = True
        except OSError as e:
            log('could not write marker %s (%s) - the VS Code panel will not flag this run as waiting' % (self.path, e))

    def remove(self):
        # The extension renames <pid> to <pid>.attaching when it claims the process; remove both.
        for p in (self.path, self.path + '.attaching', self.path + '.tmp'):
            try:
                os.unlink(p)
            except OSError:
                pass


# --- main --------------------------------------------------------------------------------------

def parse_args(argv):
    timeout = DEFAULT_TIMEOUT
    args = list(argv)
    while args and args[0] in ('-t', '--timeout'):
        if len(args) < 2:
            sys.exit(__doc__)
        try:
            timeout = float(args[1])
        except ValueError:
            sys.exit('waitattach: -t expects a number of seconds, got %r' % args[1])
        args = args[2:]
    if not args or args[0] in ('-h', '--help') or (args[0] == '-m' and len(args) < 2):
        sys.exit(__doc__)
    return timeout, args


def wait(timeout, marker):
    forever = timeout <= 0
    log('PID %d - attach now%s' % (os.getpid(), '' if forever else '; starting in %.0fs at the latest' % timeout))
    marker.write()
    deadline = None if forever else time.time() + timeout

    def on_term(signum, frame):                     # SIGTERM (e.g. the extension's Stop button) while waiting
        raise SystemExit(128 + signum)

    previous = signal.signal(signal.SIGTERM, on_term)
    try:
        while (deadline is None or time.time() < deadline) and not debugger_attached():
            time.sleep(POLL_S)
        if debugger_attached():
            time.sleep(GRACE_S)
            log('debugger attached - running')
        else:
            log('nobody attached - running anyway')
    except KeyboardInterrupt:
        log('interrupted while waiting')
        raise SystemExit(130)
    finally:
        marker.remove()
        signal.signal(signal.SIGTERM, previous)     # the program gets the handler it would have had


def run(args):
    if args[0] == '-m':                             # same sys.argv / sys.path[0] as "python -m module ..."
        sys.argv = args[1:]
        sys.path[0] = os.getcwd()
        runpy.run_module(args[1], run_name='__main__', alter_sys=True)
    else:                                           # same sys.argv / sys.path[0] as "python script.py ..."
        sys.argv = args
        sys.path[0] = os.path.dirname(os.path.abspath(args[0]))
        runpy.run_path(args[0], run_name='__main__')


def main():
    timeout, args = parse_args(sys.argv[1:])
    wait(timeout, Marker(timeout, args))
    run(args)


if __name__ == '__main__':
    main()
