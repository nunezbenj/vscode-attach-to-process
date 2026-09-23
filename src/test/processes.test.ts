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
  parseWaitAttachArgs,
  readWaitMarkers,
  claimWaitMarker,
  releaseWaitMarker,
  ensureWaitMarkerDir,
} from "../processes";
import { buildAttachConfig, parseHostPort, shellQuote, tildePath, waitCommand } from "../config";
import { findOnPath } from "../preflight";
import * as fs from "fs";
import * as os from "os";

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

describe("run-with-wait wrapper (waitattach.py)", () => {
  it("exposes the user's script and the timeout", () => {
    const r = parsePythonCmdline(["python3", "/home/u/.vscode-server/extensions/nunezbenj.python-attach-to-process-1.3.0/resources/waitattach.py", "-t", "30", "tests/test_x.py", "--tag", "a"]);
    assert.strictEqual(r.target, "tests/test_x.py");
    assert.strictEqual(r.scriptPath, "tests/test_x.py");
    assert.deepStrictEqual(r.args, ["--tag", "a"]);
    assert.deepStrictEqual(r.waitAttach, { timeout: 30 });
    assert.strictEqual(r.debugpyInternal, false);
  });
  it("-m pytest target, default timeout, own copy in ~/bin", () => {
    const r = parsePythonCmdline(["python", "/home/u/bin/waitattach.py", "-m", "pytest", "-k", "align", "tests/"]);
    assert.strictEqual(r.module, "pytest");
    assert.strictEqual(r.target, "-m pytest");
    assert.deepStrictEqual(r.args, ["-k", "align", "tests/"]);
    assert.deepStrictEqual(r.waitAttach, { timeout: 60 });
  });
  it("--timeout 0 means forever; bad values fall back to the default", () => {
    assert.deepStrictEqual(parseWaitAttachArgs(["--timeout", "0", "s.py"]), { timeout: 0, rest: ["s.py"] });
    assert.deepStrictEqual(parseWaitAttachArgs(["-t", "abc", "s.py"]), { timeout: 60, rest: ["s.py"] });
    assert.deepStrictEqual(parseWaitAttachArgs(["s.py", "-t", "5"]), { timeout: 60, rest: ["s.py", "-t", "5"] });
  });
  it("is never hidden, even though the bundled helper lives under the extensions dir", () => {
    const argv = ["python", "/home/u/.vscode-server/extensions/nunezbenj.python-attach-to-process-1.3.0/resources/waitattach.py", "run.py"];
    assert.strictEqual(classifyHidden(parsePythonCmdline(argv), argv), undefined);
  });
  it("a script that merely mentions waitattach elsewhere is not a wrapper", () => {
    const r = parsePythonCmdline(["python", "tools/waitattach_test.py", "waitattach.py"]);
    assert.strictEqual(r.waitAttach, undefined);
    assert.strictEqual(r.scriptPath, "tools/waitattach_test.py");
  });
});

describe("run-with-wait markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads waiting and attaching markers, ignores other files", () => {
    fs.writeFileSync(path.join(dir, "101"), JSON.stringify({ pid: 101, started: 1.5, timeout: 30, cwd: "/home/u/proj" }));
    fs.writeFileSync(path.join(dir, "102.attaching"), "{}");
    fs.writeFileSync(path.join(dir, "103"), "not json");
    fs.writeFileSync(path.join(dir, "104.tmp"), "{}");
    fs.writeFileSync(path.join(dir, "junk"), "");
    const m = readWaitMarkers(dir);
    assert.deepStrictEqual(m.get(101), { state: "waiting", timeout: 30, started: 1.5, cwd: "/home/u/proj" });
    assert.deepStrictEqual(m.get(102), { state: "attaching", timeout: undefined, started: undefined, cwd: undefined });
    assert.strictEqual(m.get(103)?.state, "waiting");
    assert.strictEqual(m.has(104), false);
    assert.strictEqual(m.size, 3);
  });
  it("claim is exclusive and release undoes it", () => {
    assert.strictEqual(claimWaitMarker(101, dir), true);
    assert.strictEqual(claimWaitMarker(101, dir), false); // a second window loses the race
    assert.strictEqual(readWaitMarkers(dir).get(101)?.state, "attaching");
    releaseWaitMarker(101, dir);
    assert.strictEqual(readWaitMarkers(dir).get(101)?.state, "waiting");
    assert.strictEqual(claimWaitMarker(999, dir), false);
    releaseWaitMarker(999, dir); // no marker: must not throw
  });
  it("missing directory reads as empty; ensureWaitMarkerDir creates it 0700", () => {
    assert.strictEqual(readWaitMarkers(path.join(dir, "nope")).size, 0);
    const d = ensureWaitMarkerDir(path.join(dir, "new", "deep"));
    assert.ok(d && fs.statSync(d).isDirectory());
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(d!).mode & 0o777, 0o700);
    }
  });
});

describe("waitCommand / shellQuote / tildePath", () => {
  it("quotes only what needs it", () => {
    assert.strictEqual(shellQuote("tests/test_x.py"), "tests/test_x.py");
    assert.strictEqual(shellQuote("~/bin/waitattach.py"), "~/bin/waitattach.py");
    assert.strictEqual(shellQuote("a b"), "'a b'");
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
    assert.strictEqual(shellQuote(""), "''");
    assert.strictEqual(shellQuote("-k"), "-k");
  });
  it("shortens home to ~ unless the path would need quotes", () => {
    assert.strictEqual(tildePath("/home/u/bin/waitattach.py", "/home/u"), "~/bin/waitattach.py");
    assert.strictEqual(tildePath("/home/u/my proj/x.py", "/home/u"), "/home/u/my proj/x.py");
    assert.strictEqual(tildePath("/opt/x.py", "/home/u"), "/opt/x.py");
    assert.strictEqual(tildePath("/home/user2/x.py", "/home/u"), "/home/user2/x.py");
  });
  it("builds script, module and prefix commands; -t only when not the default", () => {
    assert.strictEqual(waitCommand("~/w.py", { script: "run.py", args: ["--suts", "10.1.1.1"] }, 60), "python ~/w.py run.py --suts 10.1.1.1");
    assert.strictEqual(waitCommand("~/w.py", { module: "pytest", args: ["tests/test_x.py"] }, 120), "python ~/w.py -t 120 -m pytest tests/test_x.py");
    assert.strictEqual(waitCommand("~/w.py", {}, 0), "python ~/w.py -t 0");
    assert.strictEqual(waitCommand("/p/with space/w.py", { script: "a b.py" }, 60), "python '/p/with space/w.py' 'a b.py'");
  });
  it("round-trips through the process parser", () => {
    const cmd = waitCommand("/home/u/bin/waitattach.py", { module: "pytest", args: ["-k", "keyless", "tests/test_pa10015.py"] }, 30);
    const r = parsePythonCmdline(cmd.split(" "));
    assert.strictEqual(r.module, "pytest");
    assert.deepStrictEqual(r.args, ["-k", "keyless", "tests/test_pa10015.py"]);
    assert.deepStrictEqual(r.waitAttach, { timeout: 30 });
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
  const s = { justMyCode: false, subProcess: true, pathMappings: [], extraConfig: { logToFile: true }, debugConsole: "openOnSessionStart" as const };
  it("pid target", () => {
    const c = buildAttachConfig({ kind: "pid", pid: 77, label: "run.py" }, s);
    assert.deepStrictEqual(c, { type: "debugpy", request: "attach", name: "Attach: run.py (pid 77)", justMyCode: false, internalConsoleOptions: "openOnSessionStart", subProcess: true, processId: 77, logToFile: true });
  });
  it("connect target", () => {
    const c = buildAttachConfig({ kind: "connect", host: "localhost", port: 5678, label: "x" }, { ...s, subProcess: false, extraConfig: {}, pathMappings: [{ localRoot: "/a", remoteRoot: "/b" }] });
    assert.deepStrictEqual(c, { type: "debugpy", request: "attach", name: "Attach: localhost:5678", justMyCode: false, internalConsoleOptions: "openOnSessionStart", pathMappings: [{ localRoot: "/a", remoteRoot: "/b" }], connect: { host: "localhost", port: 5678 } });
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

  it("sees a waitattach.py run as waiting (pinned first) and as running once it proceeds", async function () {
    this.timeout(15000);
    const helper = path.join(__dirname, "..", "..", "resources", "waitattach.py");
    const w = spawn("python3", [helper, "-t", "2", script, "--tag", "mocha-wait"], { cwd: path.dirname(script), stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 700));
      let procs = await listPythonProcesses();
      const mine = procs.find((p) => p.pid === w.pid);
      assert.ok(mine, `waitattach pid ${w.pid} not listed`);
      assert.strictEqual(mine.parsed.scriptPath, script);
      assert.deepStrictEqual(mine.parsed.args, ["--tag", "mocha-wait"]);
      assert.deepStrictEqual(mine.parsed.waitAttach, { timeout: 2 });
      assert.strictEqual(mine.wait?.state, "waiting");
      assert.strictEqual(mine.wait?.cwd, path.dirname(script));
      assert.strictEqual(mine.hidden, false);
      assert.strictEqual(procs[0].pid, w.pid, "waiting process should be listed first");
      await new Promise((r) => setTimeout(r, 3000)); // -t 2 elapsed: the helper removed its marker and runs the sleeper
      procs = await listPythonProcesses();
      const later = procs.find((p) => p.pid === w.pid);
      assert.ok(later, "process should still be running");
      assert.strictEqual(later.wait, undefined);
    } finally {
      w.kill();
    }
  });
});
