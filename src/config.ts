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
