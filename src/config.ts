/**
 * Builds the debug configuration handed to vscode.debug.startDebugging().
 * Never written to launch.json: it exists only for the session.
 */

export interface AttachSettings {
  justMyCode: boolean;
  subProcess: boolean;
  pathMappings: Array<{ localRoot: string; remoteRoot: string }>;
  extraConfig: Record<string, unknown>;
  /** VS Code's internalConsoleOptions: reveal the Debug Console when the session starts. */
  debugConsole: "openOnSessionStart" | "openOnFirstSessionStart" | "neverOpen";
  /** Ask debugpy to write its own logs (Python Debugger extension's log folder). */
  debugpyLogToFile?: boolean;
}

export interface PidTarget {
  kind: "pid";
  pid: number;
  label: string;
}

export interface ConnectTarget {
  kind: "connect";
  host: string;
  port: number;
  label: string;
}

export type AttachTarget = PidTarget | ConnectTarget;

export type DebugConfig = Record<string, unknown> & { type: string; request: string; name: string };

export function buildAttachConfig(target: AttachTarget, s: AttachSettings): DebugConfig {
  const base: DebugConfig = {
    type: "debugpy",
    request: "attach",
    name: target.kind === "pid" ? `Attach: ${target.label} (pid ${target.pid})` : `Attach: ${target.host}:${target.port}`,
    justMyCode: s.justMyCode,
    internalConsoleOptions: s.debugConsole,
  };
  if (s.subProcess) {
    base.subProcess = true;
  }
  if (s.debugpyLogToFile) {
    base.logToFile = true;
  }
  if (s.pathMappings.length > 0) {
    base.pathMappings = s.pathMappings;
  }
  if (target.kind === "pid") {
    base.processId = target.pid;
  } else {
    base.connect = { host: target.host, port: target.port };
  }
  return { ...base, ...s.extraConfig, type: "debugpy", request: "attach" };
}

/** Validate a "host:port" or "port" string typed by the user. */
export function parseHostPort(text: string, defaultHost: string): { host: string; port: number } | string {
  const t = text.trim();
  if (!t) {
    return "Enter host:port or a port number";
  }
  let host = defaultHost;
  let portStr = t;
  const idx = t.lastIndexOf(":");
  if (idx >= 0) {
    host = t.slice(0, idx).trim() || defaultHost;
    portStr = t.slice(idx + 1).trim();
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Port must be an integer between 1 and 65535";
  }
  return { host, port };
}

export function listenCommand(port: number): string {
  return `python -m debugpy --listen ${port} --wait-for-client your_script.py`;
}

// ---------------------------------------------------------------------------
// Run-with-wait command (resources/waitattach.py)
// ---------------------------------------------------------------------------

/** POSIX-shell quoting for one word: unchanged when safe, single-quoted otherwise. */
export function shellQuote(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(word)) {
    return word;
  }
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Show a path under the user's home as ~/... (only when it needs no quoting; a quoted ~ would not expand). */
export function tildePath(p: string, home: string): string {
  if (home && p.startsWith(home + "/") && shellQuote(p) === p) {
    return "~" + p.slice(home.length);
  }
  return p;
}

export interface WaitCommandTarget {
  /** Script path, or module name when `module` is set. */
  script?: string;
  module?: string;
  args?: string[];
}

/**
 * `python <helper> [-t N] (script.py | -m module) [args]`
 * The timeout is emitted only when it differs from the helper's built-in default.
 */
export function waitCommand(helperPath: string, target: WaitCommandTarget, timeout: number, defaultTimeout = 60, python = "python"): string {
  const words = [python, helperPath];
  if (timeout !== defaultTimeout) {
    words.push("-t", String(timeout));
  }
  if (target.module) {
    words.push("-m", target.module);
  } else if (target.script) {
    words.push(target.script);
  }
  words.push(...(target.args ?? []));
  return words.map(shellQuote).join(" ");
}
