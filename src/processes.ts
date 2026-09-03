/**
 * Discovery of the current user's running Python processes.
 *
 * Linux: reads /proc directly (owner uid, cmdline, exe, cwd, start time).
 * macOS: falls back to `ps`. Windows: not supported (the extension runs on
 * the remote host under Remote-SSH, so a Windows laptop + Linux server works).
 *
 * Everything that does not touch the OS is pure so it can be unit tested.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

export interface DebugpyListen {
  host: string;
  port: number;
  waitForClient: boolean;
}

export interface ParsedCmdline {
  /** Human label of what is running: script path, "-m module", "-c <inline>", or "<stdin>". */
  target: string;
  /** Path of the script when the target is a script file, else undefined. */
  scriptPath?: string;
  /** Module name when run with -m, else undefined. */
  module?: string;
  /** Arguments after the target. */
  args: string[];
  /** Set when the process was launched via `python -m debugpy --listen ...`. */
  debugpyListen?: DebugpyListen;
  /** True for debugpy's own helper processes (adapter, injector, launcher). */
  debugpyInternal: boolean;
}

export interface PythonProcess {
  pid: number;
  cmdline: string[];
  exe: string;
  cwd: string;
  ageSeconds?: number;
  parsed: ParsedCmdline;
  /** Editor/tooling process the picker hides by default; `hiddenReason` says why. */
  hidden: boolean;
  hiddenReason?: string;
}

export interface ListOptions {
  /** Regex applied to the joined command line; only matches are returned. */
  filter?: RegExp;
  /** PIDs never to list (the extension host itself, for instance). */
  excludePids?: number[];
  log?: (msg: string) => void;
}

const PYTHON_EXE = /^python(\d+(\.\d+)?)?(m|d|t)?(\.exe)?$/i;

export function isPythonExecutable(p: string): boolean {
  return PYTHON_EXE.test(path.basename(p));
}

/** Options of the python interpreter that consume the next argv element. */
const PY_OPTS_WITH_VALUE = new Set(["-W", "-X", "--check-hash-based-pycs"]);

/**
 * Parse a Python process command line into what is actually running.
 * argv[0] is normally the interpreter; if it is not python-like (console-script
 * entry points, wrappers) it is treated as the target itself.
 */
export function parsePythonCmdline(argv: string[]): ParsedCmdline {
  const out: ParsedCmdline = { target: "", args: [], debugpyInternal: false };
  if (argv.length === 0) {
    return out;
  }
  let i = 0;
  if (isPythonExecutable(argv[0])) {
    i = 1;
  }
  const rest = parseInterpreterArgs(argv, i);
  Object.assign(out, rest);

  // debugpy wrapping: `python -m debugpy [--listen ...|--connect ...] [--pid N] target`
  if (out.module === "debugpy" || /[\\/]debugpy$/.test(out.scriptPath ?? "")) {
    const inner = parseDebugpyArgs(out.args);
    if (inner.internal) {
      out.debugpyInternal = true;
      return out;
    }
    const innerParsed = parseInterpreterArgs(inner.rest, 0);
    // Keep the *user's* target as the label; remember the listen endpoint.
    out.target = innerParsed.target;
    out.scriptPath = innerParsed.scriptPath;
    out.module = innerParsed.module;
    out.args = innerParsed.args;
    out.debugpyListen = inner.listen;
    return out;
  }
  if (out.module === "debugpy.adapter" || out.module === "debugpy.launcher" ||
      /[\\/]debugpy[\\/](adapter|launcher)$/.test(out.scriptPath ?? "")) {
    out.debugpyInternal = true;
  }
  return out;
}

function parseInterpreterArgs(argv: string[], start: number): Omit<ParsedCmdline, "debugpyInternal"> {
  const result: Omit<ParsedCmdline, "debugpyInternal"> = { target: "", args: [] };
  let i = start;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-") {
      result.target = "<stdin>";
      result.args = argv.slice(i + 1);
      return result;
    }
    if (a === "--") {
      i++;
      break;
    }
    if (a.startsWith("-") && a.length > 1) {
      // -m mod / -c code, possibly glued to other flags: -um mod, -Bc code
      const mc = /^-[a-zA-Z]*([mc])$/.exec(a);
      if (mc) {
        if (mc[1] === "m") {
          result.module = argv[i + 1] ?? "";
          result.target = `-m ${result.module}`;
        } else {
          result.target = "-c <inline>";
        }
        result.args = argv.slice(i + 2);
        return result;
      }
      if (PY_OPTS_WITH_VALUE.has(a)) {
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    result.target = a;
    result.scriptPath = a;
    result.args = argv.slice(i + 1);
    return result;
  }
  // `python --` with nothing, or bare `python`: interactive shell
  result.target = "<interactive>";
  return result;
}

interface DebugpyArgs {
  listen?: DebugpyListen;
  internal: boolean;
  rest: string[];
}

/** Parse debugpy CLI options up to the user's target. */
export function parseDebugpyArgs(args: string[]): DebugpyArgs {
  const out: DebugpyArgs = { internal: false, rest: [] };
  let waitForClient = false;
  let listen: { host: string; port: number } | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--listen" || a === "--connect") {
      const ep = parseEndpoint(args[i + 1] ?? "");
      if (a === "--listen") {
        listen = ep;
      } else {
        out.internal = true; // reverse-connect client: already talking to an adapter
      }
      i += 2;
      continue;
    }
    if (a === "--pid") {
      out.internal = true; // the injector itself
      i += 2;
      continue;
    }
    if (a === "--wait-for-client") {
      waitForClient = true;
      i++;
      continue;
    }
    if (a === "--adapter-access-token" || a === "--log-to" || a === "--config") {
      i += 2;
      continue;
    }
    if (a.startsWith("--")) {
      i++;
      continue;
    }
    break;
  }
  out.rest = args.slice(i);
  if (listen) {
    out.listen = { ...listen, waitForClient };
  }
  return out;
}

/** "5678" -> localhost:5678; "0.0.0.0:5678" -> localhost:5678; "host:5678" -> host:5678 */
export function parseEndpoint(spec: string): { host: string; port: number } {
  let host = "localhost";
  let portStr = spec;
  const idx = spec.lastIndexOf(":");
  if (idx >= 0) {
    host = spec.slice(0, idx) || "localhost";
    portStr = spec.slice(idx + 1);
  }
  if (host === "0.0.0.0" || host === "::" || host === "127.0.0.1" || host === "[::]") {
    host = "localhost";
  }
  return { host, port: parseInt(portStr, 10) || 0 };
}

const TOOLING_PATH = /[\\/]\.(vscode-server|vscode-server-insiders|cursor-server|vscode|windsurf-server)[\\/]/;
const TOOLING_MODULE = /(language_server|lsp|pylsp|jedi|pyright|ruff|black|isort|flake8|mypy|debugpy)/i;

/** Decide whether a process is editor/debugger tooling rather than a user's program. */
export function classifyHidden(parsed: ParsedCmdline, cmdline: string[]): string | undefined {
  if (parsed.debugpyInternal) {
    return "debugpy helper (adapter/injector)";
  }
  const joined = cmdline.join(" ");
  if (TOOLING_PATH.test(joined)) {
    return "editor tooling (installed under the VS Code Server / extensions directory)";
  }
  if (parsed.module && TOOLING_MODULE.test(parsed.module)) {
    return `tooling module (${parsed.module})`;
  }
  if (parsed.scriptPath && /(pylsp|jedi.language.server|pyright|ruff|black|isort|flake8|mypy)$/i.test(path.basename(parsed.scriptPath))) {
    return `tooling (${path.basename(parsed.scriptPath)})`;
  }
  return undefined;
}

/** Display the script relative to its cwd when it lives inside it. */
export function displayTarget(parsed: ParsedCmdline, cwd: string): string {
  if (parsed.scriptPath && cwd) {
    const abs = path.isAbsolute(parsed.scriptPath) ? parsed.scriptPath : path.join(cwd, parsed.scriptPath);
    const rel = path.relative(cwd, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel;
    }
    return abs;
  }
  return parsed.target;
}

export function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) {
    return "";
  }
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m} min`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}h ${m % 60}m`;
  }
  return `${Math.floor(h / 24)}d`;
}

export function isSupportedPlatform(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

/** List the current user's Python processes on this host. */
export async function listPythonProcesses(opts: ListOptions = {}): Promise<PythonProcess[]> {
  const log = opts.log ?? (() => undefined);
  let procs: PythonProcess[];
  if (process.platform === "linux") {
    procs = await listLinux(log);
  } else if (process.platform === "darwin") {
    procs = await listViaPs(log);
  } else {
    return [];
  }
  const exclude = new Set(opts.excludePids ?? []);
  exclude.add(process.pid);
  procs = procs.filter((p) => !exclude.has(p.pid));
  if (opts.filter) {
    procs = procs.filter((p) => opts.filter!.test(p.cmdline.join(" ")));
  }
  procs.sort((a, b) => (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity));
  return procs;
}

// ---------------------------------------------------------------------------
// Linux (/proc)
// ---------------------------------------------------------------------------

let clkTckCache: number | undefined;

async function clockTicks(): Promise<number> {
  if (clkTckCache) {
    return clkTckCache;
  }
  clkTckCache = await new Promise<number>((resolve) => {
    execFile("getconf", ["CLK_TCK"], { timeout: 2000 }, (err, stdout) => {
      const n = err ? NaN : parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(n) && n > 0 ? n : 100);
    });
  });
  return clkTckCache;
}

async function readUptime(): Promise<number | undefined> {
  try {
    const txt = await fs.promises.readFile("/proc/uptime", "utf8");
    return parseFloat(txt.split(" ")[0]);
  } catch {
    return undefined;
  }
}

/** Parse /proc/<pid>/stat and return starttime in clock ticks since boot. */
export function parseStatStartTime(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) {
    return undefined;
  }
  // Fields after ')' start at field 3 (state). starttime is field 22 -> index 19.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const v = parseInt(fields[19], 10);
  return Number.isFinite(v) ? v : undefined;
}

async function listLinux(log: (m: string) => void): Promise<PythonProcess[]> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const [tck, uptime] = await Promise.all([clockTicks(), readUptime()]);
  let entries: string[];
  try {
    entries = await fs.promises.readdir("/proc");
  } catch (e) {
    log(`cannot read /proc: ${e}`);
    return [];
  }
  const pids = entries.filter((e) => /^\d+$/.test(e)).map((e) => parseInt(e, 10));
  const results = await Promise.all(pids.map((pid) => inspectLinuxPid(pid, uid, tck, uptime, log)));
  return results.filter((p): p is PythonProcess => p !== undefined);
}

async function inspectLinuxPid(
  pid: number,
  uid: number,
  tck: number,
  uptime: number | undefined,
  log: (m: string) => void,
): Promise<PythonProcess | undefined> {
  const dir = `/proc/${pid}`;
  try {
    const st = await fs.promises.stat(dir);
    if (uid >= 0 && st.uid !== uid) {
      return undefined;
    }
    const raw = await fs.promises.readFile(`${dir}/cmdline`);
    if (raw.length === 0) {
      return undefined; // kernel thread or zombie
    }
    const cmdline = raw.toString("utf8").split("\0");
    if (cmdline[cmdline.length - 1] === "") {
      cmdline.pop();
    }
    let exe = "";
    try {
      exe = await fs.promises.readlink(`${dir}/exe`);
      exe = exe.replace(/ \(deleted\)$/, "");
    } catch {
      /* permission or gone */
    }
    if (!isPythonExecutable(exe) && !isPythonExecutable(cmdline[0] ?? "")) {
      return undefined;
    }
    let cwd = "";
    try {
      cwd = await fs.promises.readlink(`${dir}/cwd`);
    } catch {
      /* ignore */
    }
    let ageSeconds: number | undefined;
    try {
      const stat = await fs.promises.readFile(`${dir}/stat`, "utf8");
      const start = parseStatStartTime(stat);
      if (start !== undefined && uptime !== undefined) {
        ageSeconds = uptime - start / tck;
      }
    } catch {
      /* ignore */
    }
    const parsed = parsePythonCmdline(cmdline);
    const hiddenReason = classifyHidden(parsed, cmdline);
    const proc: PythonProcess = {
      pid,
      cmdline,
      exe,
      cwd,
      ageSeconds,
      parsed,
      hidden: hiddenReason !== undefined,
      hiddenReason,
    };
    log(`pid ${pid}: ${parsed.target}${hiddenReason ? ` [hidden: ${hiddenReason}]` : ""}`);
    return proc;
  } catch {
    return undefined; // process exited mid-scan
  }
}

// ---------------------------------------------------------------------------
// macOS (ps)
// ---------------------------------------------------------------------------

async function listViaPs(log: (m: string) => void): Promise<PythonProcess[]> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const stdout = await new Promise<string>((resolve) => {
    execFile("ps", ["-axo", "pid=,uid=,etimes=,command="], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) {
        log(`ps failed: ${err.message}`);
      }
      resolve(out ?? "");
    });
  });
  const procs: PythonProcess[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const [, pidS, uidS, etS, cmd] = m;
    if (uid >= 0 && parseInt(uidS, 10) !== uid) {
      continue;
    }
    const cmdline = cmd.trim().split(/\s+/);
    if (!isPythonExecutable(cmdline[0] ?? "")) {
      continue;
    }
    const parsed = parsePythonCmdline(cmdline);
    const hiddenReason = classifyHidden(parsed, cmdline);
    procs.push({
      pid: parseInt(pidS, 10),
      cmdline,
      exe: cmdline[0],
      cwd: "",
      ageSeconds: parseInt(etS, 10),
      parsed,
      hidden: hiddenReason !== undefined,
      hiddenReason,
    });
  }
  return procs;
}

export function homeDir(): string {
  return os.homedir();
}
