"""End-to-end check of the attach path without VS Code.

Starts test-python/sleeper.py from a plain subprocess (not a child of the
adapter, exactly like a script launched from another terminal), then speaks
DAP to a debugpy adapter using the same configuration the extension builds:

    {"type": "debugpy", "request": "attach", "processId": <pid>, "justMyCode": true}

Success = the adapter injects debugpy into the sleeper and a breakpoint on the
`total += n` line reports a `stopped` event.  Then we disconnect and attach a
second time to see what a re-attach does (useful to know for the README).

Usage: python3 test-python/e2e_attach.py [--config JSON]
Requires gdb and ptrace permission (same as the extension).
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SLEEPER = os.path.join(HERE, "sleeper.py")
BP_LINE = next(i for i, l in enumerate(open(SLEEPER), 1) if "breakpoint here" in l)


class Dap:
    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=60)
        self.buf = b""
        self.seq = 0
        self.events = []

    def send(self, command, arguments=None):
        self.seq += 1
        msg = {"seq": self.seq, "type": "request", "command": command, "arguments": arguments or {}}
        data = json.dumps(msg).encode()
        self.sock.sendall(b"Content-Length: %d\r\n\r\n" % len(data) + data)
        return self.seq

    def recv(self):
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("adapter closed")
            self.buf += chunk
        head, _, rest = self.buf.partition(b"\r\n\r\n")
        length = int(head.decode().split(":")[1])
        while len(rest) < length:
            rest += self.sock.recv(65536)
        body, self.buf = rest[:length], rest[length:]
        return json.loads(body)

    def request(self, command, arguments=None):
        seq = self.send(command, arguments)
        while True:
            m = self.recv()
            if m["type"] == "event":
                self.events.append(m)
                if m["event"] == "output":
                    sys.stdout.write("  [dbg] " + m["body"].get("output", "").rstrip() + "\n")
            elif m["type"] == "response" and m["request_seq"] == seq:
                if not m.get("success"):
                    raise RuntimeError(f"{command} failed: {m.get('message')} {m.get('body')}")
                return m

    def wait_response(self, seq, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = self.recv()
            if m["type"] == "event":
                self.events.append(m)
            elif m["type"] == "response" and m["request_seq"] == seq:
                if not m.get("success"):
                    raise RuntimeError(f"{m.get('command')} failed: {m.get('message')}")
                return m
        raise TimeoutError(f"no response to #{seq}")

    def wait_event(self, name, timeout=60):
        for e in self.events:
            if e["event"] == name:
                self.events.remove(e)
                return e
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = self.recv()
            if m["type"] == "event":
                if m["event"] == "output":
                    sys.stdout.write("  [dbg] " + m["body"].get("output", "").rstrip() + "\n")
                if m["event"] == name:
                    return m
                self.events.append(m)
        raise TimeoutError(f"no {name} event")


def attach_once(port, config, label):
    print(f"--- {label}: attach with {json.dumps(config)}")
    dap = Dap("127.0.0.1", port)
    dap.request("initialize", {"clientID": "e2e", "adapterID": "debugpy", "pathFormat": "path",
                               "linesStartAt1": True, "columnsStartAt1": True,
                               "supportsRunInTerminalRequest": False})
    # debugpy answers "attach" only after configurationDone, so don't block on it.
    attach_seq = dap.send("attach", config)
    dap.wait_event("initialized", 60)
    r = dap.request("setBreakpoints", {"source": {"path": SLEEPER}, "breakpoints": [{"line": BP_LINE}]})
    bp = r["body"]["breakpoints"][0]
    print(f"  breakpoint line {BP_LINE} verified={bp.get('verified')}")
    dap.request("configurationDone")
    dap.wait_response(attach_seq)
    ev = dap.wait_event("stopped", 30)
    tid = ev["body"]["threadId"]
    frames = dap.request("stackTrace", {"threadId": tid})["body"]["stackFrames"]
    top = frames[0]
    print(f"  STOPPED at {os.path.basename(top['source']['path'])}:{top['line']} in {top['name']}")
    scopes = dap.request("scopes", {"frameId": top["id"]})["body"]["scopes"]
    vars_ = dap.request("variables", {"variablesReference": scopes[0]["variablesReference"]})["body"]["variables"]
    shown = {v["name"]: v["value"] for v in vars_ if v["name"] in ("i", "n", "total")}
    print(f"  locals: {shown}")
    assert top["line"] == BP_LINE and shown["n"] == str(2 * int(shown["i"])), "wrong frame/values"
    dap.request("disconnect", {"terminateDebuggee": False})
    dap.sock.close()
    print(f"  {label}: OK (detached, process left running)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None, help="attach config JSON (processId is filled in)")
    ap.add_argument("--port", type=int, default=4711)
    args = ap.parse_args()

    sleeper = subprocess.Popen([sys.executable, SLEEPER, "--tag", "e2e"], cwd=HERE,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    adapter = subprocess.Popen([sys.executable, "-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", str(args.port)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        config = json.loads(args.config) if args.config else {"type": "debugpy", "request": "attach", "justMyCode": True}
        config["processId"] = sleeper.pid
        attach_once(args.port, config, "first attach")
        assert sleeper.poll() is None, "sleeper died after detach"
        time.sleep(1)
        adapter2 = subprocess.Popen([sys.executable, "-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", str(args.port + 1)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
        try:
            attach_once(args.port + 1, config, "second attach (re-attach after disconnect)")
        except Exception as e:  # noqa: BLE001
            # Expected with current debugpy: the second injection "succeeds" but
            # breakpoints never hit again. The extension warns about this.
            print(f"  re-attach: {type(e).__name__}: {e}  (known debugpy limitation: restart the script for a clean attach)")
        finally:
            adapter2.kill()
        print("E2E PASSED")
    finally:
        sleeper.kill()
        adapter.kill()


if __name__ == "__main__":
    main()
