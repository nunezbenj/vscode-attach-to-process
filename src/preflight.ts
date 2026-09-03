/**
 * Preflight for attach-by-PID injection on Linux.
 *
 * debugpy injects itself into a running process by driving gdb, and gdb needs
 * permission to ptrace a process that is not its child. On Ubuntu that means:
 *   1. gdb installed
 *   2. kernel.yama.ptrace_scope = 0 (default 1 only allows tracing children)
 * Both are cheap to check up front, so the user gets a one-line fix instead of
 * debugpy's traceback wall.
 */

import * as fs from "fs";
import * as path from "path";

export interface PreflightResult {
  platform: NodeJS.Platform;
  /** Injection is possible on this platform at all (Linux/macOS). */
  supported: boolean;
  gdbPath?: string;
  /** undefined when Yama is not present (then ptrace is unrestricted). */
  ptraceScope?: number;
  /** Problems that will make injection fail, each with a fix command. */
  blockers: PreflightIssue[];
  /** Things that may make injection fail; the user can try anyway. */
  warnings: PreflightIssue[];
}

export interface PreflightIssue {
  message: string;
  fix: string;
}

export const GDB_FIX = "sudo apt install -y gdb";
export const PTRACE_FIX =
  "echo 'kernel.yama.ptrace_scope = 0' | sudo tee /etc/sysctl.d/10-ptrace.conf && sudo sysctl --system";

export function findOnPath(name: string, envPath = process.env.PATH ?? ""): string | undefined {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* not here */
    }
  }
  return undefined;
}

export function readPtraceScope(): number | undefined {
  try {
    const v = parseInt(fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim(), 10);
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function runPreflight(): PreflightResult {
  const result: PreflightResult = {
    platform: process.platform,
    supported: process.platform === "linux" || process.platform === "darwin",
    blockers: [],
    warnings: [],
  };
  if (!result.supported) {
    result.blockers.push({
      message: `Attach-by-PID is only supported on Linux and macOS hosts (this extension host is ${process.platform}). Use Remote-SSH to your Linux server, or "Connect to Listening debugpy".`,
      fix: "",
    });
    return result;
  }
  if (process.platform === "linux") {
    result.gdbPath = findOnPath("gdb");
    if (!result.gdbPath) {
      result.blockers.push({
        message: "gdb is not installed — debugpy uses gdb to inject itself into the running process.",
        fix: GDB_FIX,
      });
    }
    result.ptraceScope = readPtraceScope();
    if (result.ptraceScope !== undefined && result.ptraceScope !== 0) {
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      const issue: PreflightIssue = {
        message: `kernel.yama.ptrace_scope is ${result.ptraceScope}; attaching to a process started from another terminal or SSH session needs 0.`,
        fix: PTRACE_FIX,
      };
      if (result.ptraceScope >= 2 && !isRoot) {
        result.blockers.push(issue);
      } else {
        result.warnings.push(issue);
      }
    }
  } else {
    result.warnings.push({
      message: "On macOS, attaching needs a codesigned lldb/gdb setup; if injection fails, launch the script with debugpy --listen and use Connect instead.",
      fix: "",
    });
  }
  return result;
}

export function describePreflight(r: PreflightResult): string {
  const lines: string[] = [];
  lines.push(`platform: ${r.platform}`);
  if (r.platform === "linux") {
    lines.push(`gdb: ${r.gdbPath ?? "MISSING"}`);
    lines.push(`ptrace_scope: ${r.ptraceScope === undefined ? "n/a (no Yama)" : r.ptraceScope}`);
  }
  for (const b of r.blockers) {
    lines.push(`BLOCKER: ${b.message}${b.fix ? `  fix: ${b.fix}` : ""}`);
  }
  for (const w of r.warnings) {
    lines.push(`warning: ${w.message}${w.fix ? `  fix: ${w.fix}` : ""}`);
  }
  if (r.blockers.length === 0 && r.warnings.length === 0) {
    lines.push("ready: attach-by-PID injection should work on this host");
  }
  return lines.join("\n");
}
