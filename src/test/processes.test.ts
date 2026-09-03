import * as assert from "assert";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import {
  parsePythonCmdline,
  parseDebugpyArgs,
  parseEndpoint,
  classifyHidden,
  displayTarget,
  formatAge,
  parseStatStartTime,
  listPythonProcesses,
  isPythonExecutable,
} from "../processes";
import { buildAttachConfig, parseHostPort } from "../config";
import { findOnPath } from "../preflight";

describe("isPythonExecutable", () => {
  it("matches interpreter names", () => {
    for (const p of ["python", "python3", "python3.12", "/usr/bin/python3.11", "/home/u/.pyenv/versions/3.12.3/bin/python3.12", "python.exe", "python3.13t"]) {
      assert.ok(isPythonExecutable(p), p);
    }
    for (const p of ["pythonw-ish", "node", "/usr/bin/pytest", "ipython", "python-config"]) {
      assert.ok(!isPythonExecutable(p), p);
    }
  });
});

describe("parsePythonCmdline", () => {
  it("script with args", () => {
    const r = parsePythonCmdline(["python3", "inventory.py", "--suts", "10.38.1.2"]);
    assert.strictEqual(r.target, "inventory.py");
    assert.strictEqual(r.scriptPath, "inventory.py");
    assert.deepStrictEqual(r.args, ["--suts", "10.38.1.2"]);
    assert.strictEqual(r.debugpyListen, undefined);
    assert.strictEqual(r.debugpyInternal, false);
  });
  it("interpreter flags before the script", () => {
    const r = parsePythonCmdline(["python", "-u", "-W", "ignore", "-X", "dev", "run.py", "a"]);
    assert.strictEqual(r.target, "run.py");
    assert.deepStrictEqual(r.args, ["a"]);
  });
  it("-m module and glued -um", () => {
    assert.strictEqual(parsePythonCmdline(["python", "-m", "pytest", "tests/"]).module, "pytest");
    const r = parsePythonCmdline(["python3", "-um", "pyuniti.runner", "--case", "x"]);
    assert.strictEqual(r.module, "pyuniti.runner");
    assert.strictEqual(r.target, "-m pyuniti.runner");
    assert.deepStrictEqual(r.args, ["--case", "x"]);
  });
  it("-c inline and stdin", () => {
    assert.strictEqual(parsePythonCmdline(["python3", "-c", "import time"]).target, "-c <inline>");
    assert.strictEqual(parsePythonCmdline(["python3", "-"]).target, "<stdin>");
    assert.strictEqual(parsePythonCmdline(["python3"]).target, "<interactive>");
  });
  it("console-script entry point (argv0 is not python)", () => {
    const r = parsePythonCmdline(["/venv/bin/pytest", "-x"]);
    assert.strictEqual(r.target, "/venv/bin/pytest");
    assert.deepStrictEqual(r.args, ["-x"]);
  });
  it("debugpy --listen wrapper exposes the user's script and the endpoint", () => {
    const r = parsePythonCmdline(["python", "-m", "debugpy", "--listen", "5678", "--wait-for-client", "script.py", "--flag"]);
    assert.strictEqual(r.target, "script.py");
    assert.deepStrictEqual(r.args, ["--flag"]);
    assert.deepStrictEqual(r.debugpyListen, { host: "localhost", port: 5678, waitForClient: true });
    assert.strictEqual(r.debugpyInternal, false);
  });
  it("debugpy --listen 0.0.0.0:port with -m target", () => {
    const r = parsePythonCmdline(["python", "-m", "debugpy", "--listen", "0.0.0.0:6000", "-m", "mypkg.main", "x"]);
    assert.strictEqual(r.module, "mypkg.main");
    assert.deepStrictEqual(r.debugpyListen, { host: "localhost", port: 6000, waitForClient: false });
  });
  it("debugpy helpers are internal", () => {
    // injector spawned by the adapter: python <debugpy dir> --connect h:p --pid N
    assert.ok(parsePythonCmdline(["/usr/bin/python3", "/x/libs/debugpy", "--connect", "127.0.0.1:41000", "--pid", "123"]).debugpyInternal);
    assert.ok(parsePythonCmdline(["python", "-m", "debugpy.adapter", "--for-server", "1"]).debugpyInternal);
    assert.ok(parsePythonCmdline(["python", "/x/libs/debugpy/adapter", "--host", "127.0.0.1"]).debugpyInternal);
    assert.ok(parsePythonCmdline(["python", "/x/libs/debugpy/launcher", "1234", "--", "s.py"]).debugpyInternal);
  });
});

describe("parseDebugpyArgs / parseEndpoint", () => {
  it("parses endpoints", () => {
    assert.deepStrictEqual(parseEndpoint("5678"), { host: "localhost", port: 5678 });
    assert.deepStrictEqual(parseEndpoint("0.0.0.0:5678"), { host: "localhost", port: 5678 });
    assert.deepStrictEqual(parseEndpoint("myhost:5679"), { host: "myhost", port: 5679 });
  });
  it("stops at the target", () => {
    const r = parseDebugpyArgs(["--listen", "5678", "--log-to", "/tmp", "app.py", "--listen", "not-mine"]);
    assert.deepStrictEqual(r.rest, ["app.py", "--listen", "not-mine"]);
    assert.strictEqual(r.listen?.port, 5678);
  });
});

describe("classifyHidden", () => {
  it("hides editor tooling, keeps user programs", () => {
    const hidden = (argv: string[]) => classifyHidden(parsePythonCmdline(argv), argv);
    assert.ok(hidden(["python", "/home/u/.vscode-server/extensions/ms-python.python-2026.1/python_files/get_output_via_markers.py"]));
    assert.ok(hidden(["python", "-m", "debugpy.adapter"]));
    assert.ok(hidden(["python", "-m", "pylsp"]));
    assert.ok(hidden(["/venv/bin/python", "/venv/bin/jedi-language-server"]));
    assert.strictEqual(hidden(["python", "inventory.py"]), undefined);
    assert.strictEqual(hidden(["python", "-m", "pyuniti.runner"]), undefined);
    assert.strictEqual(hidden(["python", "-m", "debugpy", "--listen", "5678", "s.py"]), undefined);
    assert.strictEqual(hidden(["python", "-m", "ipykernel_launcher", "-f", "k.json"]), undefined);
  });
});

describe("displayTarget / formatAge / stat", () => {
  it("shows scripts relative to cwd", () => {
    const p = parsePythonCmdline(["python", "/home/u/proj/tools/run.py"]);
    assert.strictEqual(displayTarget(p, "/home/u/proj"), path.join("tools", "run.py"));
    assert.strictEqual(displayTarget(p, "/home/u/other"), "/home/u/proj/tools/run.py");
    assert.strictEqual(displayTarget(parsePythonCmdline(["python", "-m", "x"]), "/h"), "-m x");
  });
  it("formats ages", () => {
    assert.strictEqual(formatAge(5), "5s");
    assert.strictEqual(formatAge(1260), "21 min");
    assert.strictEqual(formatAge(3 * 3600 + 120), "3h 2m");
    assert.strictEqual(formatAge(3 * 86400), "3d");
    assert.strictEqual(formatAge(undefined), "");
  });
  it("parses starttime out of /proc/pid/stat with spaces in comm", () => {
    const stat = "42 (py thing) S 1 42 42 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 987654 1000 200 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
    assert.strictEqual(parseStatStartTime(stat), 987654);
  });
});

describe("buildAttachConfig", () => {
  const s = { justMyCode: false, subProcess: true, pathMappings: [], extraConfig: { logToFile: true } };
  it("pid target", () => {
    const c = buildAttachConfig({ kind: "pid", pid: 77, label: "run.py" }, s);
    assert.deepStrictEqual(c, { type: "debugpy", request: "attach", name: "Attach: run.py (pid 77)", justMyCode: false, subProcess: true, processId: 77, logToFile: true });
  });
  it("connect target", () => {
    const c = buildAttachConfig({ kind: "connect", host: "localhost", port: 5678, label: "x" }, { ...s, subProcess: false, extraConfig: {}, pathMappings: [{ localRoot: "/a", remoteRoot: "/b" }] });
    assert.deepStrictEqual(c, { type: "debugpy", request: "attach", name: "Attach: localhost:5678", justMyCode: false, pathMappings: [{ localRoot: "/a", remoteRoot: "/b" }], connect: { host: "localhost", port: 5678 } });
  });
  it("extraConfig cannot change type/request", () => {
    const c = buildAttachConfig({ kind: "pid", pid: 1, label: "x" }, { ...s, extraConfig: { type: "node", request: "launch" } });
    assert.strictEqual(c.type, "debugpy");
    assert.strictEqual(c.request, "attach");
  });
  it("parseHostPort", () => {
    assert.deepStrictEqual(parseHostPort("5678", "localhost"), { host: "localhost", port: 5678 });
    assert.deepStrictEqual(parseHostPort("brm-4:5679", "localhost"), { host: "brm-4", port: 5679 });
    assert.strictEqual(typeof parseHostPort("abc", "localhost"), "string");
    assert.strictEqual(typeof parseHostPort("", "localhost"), "string");
  });
});

describe("findOnPath", () => {
  it("finds sh, misses nonsense", () => {
    assert.ok(findOnPath("sh"));
    assert.strictEqual(findOnPath("definitely-not-a-binary-xyz"), undefined);
  });
});

describe("live process discovery", function () {
  let child: ChildProcess | undefined;
  const script = path.join(__dirname, "..", "..", "test-python", "sleeper.py");

  before(function () {
    if (process.platform !== "linux" && process.platform !== "darwin") {
      this.skip();
    }
    child = spawn("python3", [script, "--tag", "mocha-live"], { cwd: path.dirname(script), stdio: "ignore" });
  });
  after(() => child?.kill());

  it("lists the sleeper with script, args, cwd and age", async () => {
    await new Promise((r) => setTimeout(r, 400));
    const procs = await listPythonProcesses();
    const mine = procs.find((p) => p.pid === child!.pid);
    assert.ok(mine, `sleeper pid ${child!.pid} not found in ${procs.map((p) => p.pid).join(",")}`);
    assert.strictEqual(mine.parsed.scriptPath, script);
    assert.deepStrictEqual(mine.parsed.args, ["--tag", "mocha-live"]);
    assert.strictEqual(mine.hidden, false);
    if (process.platform === "linux") {
      assert.strictEqual(mine.cwd, path.dirname(script));
      assert.strictEqual(displayTarget(mine.parsed, mine.cwd), "sleeper.py");
      assert.ok(mine.ageSeconds !== undefined && mine.ageSeconds >= 0 && mine.ageSeconds < 30, `age ${mine.ageSeconds}`);
      assert.ok(isPythonExecutable(mine.exe), mine.exe);
    }
    assert.ok(!procs.some((p) => p.pid === process.pid));
  });

  it("honors the filter", async () => {
    const procs = await listPythonProcesses({ filter: /mocha-live/ });
    assert.ok(procs.every((p) => p.cmdline.join(" ").includes("mocha-live")));
    assert.ok(procs.some((p) => p.pid === child!.pid));
  });
});
