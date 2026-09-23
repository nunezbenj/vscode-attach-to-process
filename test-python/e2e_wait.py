"""End-to-end check of the run-with-wait path without VS Code.

Starts test-python/quick.py through resources/waitattach.py (a program that would normally
exit before anyone could attach), then attaches by PID through a debugpy adapter exactly like
the extension does.  Success = the marker file appears while the helper waits, the breakpoint
on the first iteration of the loop reports a `stopped` event (so the debugger was in place
before the program ran), the marker is gone once the helper proceeds, and the program finishes
normally after `continue`.

Usage: python3 test-python/e2e_wait.py [--port 4721]
Requires gdb and ptrace permission (same as the extension); reuses the DAP client of e2e_attach.py.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from e2e_attach import Dap  # noqa: E402

HELPER = os.path.join(HERE, "..", "resources", "waitattach.py")
QUICK = os.path.join(HERE, "quick.py")
BP_LINE = next(i for i, l in enumerate(open(QUICK), 1) if "breakpoint here" in l)
MARKER_DIR = os.path.join(tempfile.gettempdir(), "waitattach-%s" % os.getuid())


def wait_for(cond, seconds, what):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if cond():
            return
        time.sleep(0.1)
    raise TimeoutError(what)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4721)
    args = ap.parse_args()

    prog = subprocess.Popen([sys.executable, HELPER, "-t", "60", QUICK, "--n", "3"], cwd=HERE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    marker = os.path.join(MARKER_DIR, str(prog.pid))
    adapter = subprocess.Popen([sys.executable, "-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", str(args.port)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(lambda: os.path.exists(marker), 5, "helper did not write its marker %s" % marker)
        body = json.load(open(marker))
        assert body["pid"] == prog.pid and body["argv"] == [QUICK, "--n", "3"] and body["cwd"] == HERE, body
        print("marker OK: %s -> %s" % (marker, body))

        # what the extension does before attaching: claim the marker (atomic rename)
        os.rename(marker, marker + ".attaching")
        assert not os.path.exists(marker) and os.path.exists(marker + ".attaching")

        time.sleep(1.5)  # adapter startup
        config = {"type": "debugpy", "request": "attach", "justMyCode": True, "processId": prog.pid}
        print("--- attach with %s" % json.dumps(config))
        dap = Dap("127.0.0.1", args.port)
        dap.request("initialize", {"clientID": "e2e", "adapterID": "debugpy", "pathFormat": "path",
                                   "linesStartAt1": True, "columnsStartAt1": True, "supportsRunInTerminalRequest": False})
        attach_seq = dap.send("attach", config)
        dap.wait_event("initialized", 60)
        r = dap.request("setBreakpoints", {"source": {"path": QUICK}, "breakpoints": [{"line": BP_LINE}]})
        print("  breakpoint line %d verified=%s" % (BP_LINE, r["body"]["breakpoints"][0].get("verified")))
        dap.request("configurationDone")
        dap.wait_response(attach_seq)
        t_attached = time.time()
        print("  attach response received")

        ev = dap.wait_event("stopped", 30)
        tid = ev["body"]["threadId"]
        top = dap.request("stackTrace", {"threadId": tid})["body"]["stackFrames"][0]
        print("  STOPPED at %s:%d in %s, %.1fs after the attach response" % (os.path.basename(top["source"]["path"]), top["line"], top["name"], time.time() - t_attached))
        scopes = dap.request("scopes", {"frameId": top["id"]})["body"]["scopes"]
        vars_ = {v["name"]: v["value"] for v in dap.request("variables", {"variablesReference": scopes[0]["variablesReference"]})["body"]["variables"]}
        print("  locals: %s" % {k: vars_.get(k) for k in ("i", "total")})
        assert top["line"] == BP_LINE and vars_["i"] == "0" and vars_["total"] == "0", "not the first iteration: %s" % vars_
        wait_for(lambda: not os.path.exists(marker) and not os.path.exists(marker + ".attaching"), 5, "helper left its marker behind")
        print("  marker removed once the helper proceeded")

        dap.request("continue", {"threadId": tid})
        dap.request("disconnect", {"terminateDebuggee": False})
        dap.sock.close()
        out, err = prog.communicate(timeout=20)
        print("  program exit %d, stdout %r" % (prog.returncode, out.strip()))
        for line in err.splitlines():
            print("  [helper] " + line)
        assert prog.returncode == 0 and "total=3" in out, "program did not finish normally"
        assert "debugger attached - running" in err, "helper did not report the attach"
        print("E2E WAIT PASSED")
    finally:
        if prog.poll() is None:
            prog.kill()
        adapter.kill()
        for p in (marker, marker + ".attaching"):
            try:
                os.unlink(p)
            except OSError:
                pass


if __name__ == "__main__":
    main()
