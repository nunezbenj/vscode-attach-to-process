import * as vscode from "vscode";
import * as path from "path";
import {
  PythonProcess,
  listPythonProcesses,
  displayTarget,
  formatAge,
  isSupportedPlatform,
} from "./processes";
import { runPreflight, describePreflight, PreflightResult } from "./preflight";
import { AttachSettings, AttachTarget, buildAttachConfig, parseHostPort, listenCommand } from "./config";
import { ProcessTree, ProcessItem } from "./tree";

let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem | undefined;
let tree: ProcessTree | undefined;
/** PIDs this extension host has injected into (debugpy cannot cleanly re-attach after a disconnect). */
const injectedPids = new Set<number>();
/** Active attach sessions keyed by PID. */
const activeByPid = new Map<number, vscode.DebugSession>();
export type AttachState = { phase: "injecting"; since: number } | { phase: "attached"; threads?: number } | { phase: "failed"; reason: string };
const stateByPid = new Map<number, AttachState>();
/** Resolvers for the progress notification shown while injecting. */
const settleByPid = new Map<number, () => void>();
const INJECT_HINT_MS = 15000;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  output.appendLine(`[${ts}] ${msg}`);
}

function settings(): AttachSettings & {
  processFilter: string;
  showHidden: boolean;
  defaultHost: string;
  defaultPort: number;
  verbose: boolean;
  showStatusBar: boolean;
} {
  const c = vscode.workspace.getConfiguration("attach");
  return {
    justMyCode: c.get<boolean>("justMyCode", true),
    subProcess: c.get<boolean>("subProcess", false),
    pathMappings: c.get<Array<{ localRoot: string; remoteRoot: string }>>("pathMappings", []),
    extraConfig: c.get<Record<string, unknown>>("extraConfig", {}),
    debugConsole: c.get<"openOnSessionStart" | "openOnFirstSessionStart" | "neverOpen">("debugConsole", "openOnSessionStart"),
    processFilter: c.get<string>("processFilter", ""),
    showHidden: c.get<boolean>("showHiddenProcesses", false),
    defaultHost: c.get<string>("defaultHost", "localhost"),
    defaultPort: c.get<number>("defaultPort", 5678),
    verbose: c.get<boolean>("verboseLogging", false),
    showStatusBar: c.get<boolean>("showStatusBarItem", true),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Attach to Process");
  context.subscriptions.push(output);
  log(`activated on ${process.platform} (extension host pid ${process.pid})`);

  context.subscriptions.push(
    vscode.commands.registerCommand("attach.pickProcess", pickAndAttach),
    vscode.commands.registerCommand("attach.connect", connectToListening),
    vscode.commands.registerCommand("attach.copyListenCommand", copyListenCommand),
    vscode.commands.registerCommand("attach.checkReadiness", checkReadiness),
    vscode.commands.registerCommand("attach.showLog", () => output.show(true)),
    vscode.commands.registerCommand("attach.attachItem", async (item?: ProcessItem) => {
      if (item?.proc) {
        await attachToProcess(item.proc, runPreflight());
      } else {
        await pickAndAttach();
      }
    }),
    vscode.commands.registerCommand("attach.refreshView", () => tree?.refresh()),
    vscode.commands.registerCommand("attach.showHiddenInView", () => tree?.toggleHidden()),
    vscode.commands.registerCommand("attach.hideHiddenInView", () => tree?.toggleHidden()),
    vscode.commands.registerCommand("attach.copyCommandLine", async (item?: ProcessItem) => {
      if (item?.proc) {
        await vscode.env.clipboard.writeText(item.proc.cmdline.join(" "));
        vscode.window.setStatusBarMessage("$(check) Command line copied", 3000);
      }
    }),
    vscode.commands.registerCommand("attach.copyPid", async (item?: ProcessItem) => {
      if (item?.proc) {
        await vscode.env.clipboard.writeText(String(item.proc.pid));
        vscode.window.setStatusBarMessage(`$(check) Copied pid ${item.proc.pid}`, 3000);
      }
    }),
    vscode.debug.onDidStartDebugSession((s) => {
      if (s.configuration.type === "debugpy" && s.configuration.request === "attach") {
        log(`session started: ${s.name}`);
        const pid = s.configuration.processId;
        if (typeof pid === "number") {
          injectedPids.add(pid);
          activeByPid.set(pid, s);
          stateByPid.set(pid, { phase: "injecting", since: Date.now() });
        }
        tree?.refresh();
      }
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.configuration.type === "debugpy" && s.configuration.request === "attach") {
        log(`session ended: ${s.name}`);
        const pid = s.configuration.processId;
        if (typeof pid === "number" && activeByPid.get(pid) === s) {
          activeByPid.delete(pid);
          const st = stateByPid.get(pid);
          if (st?.phase === "injecting") {
            stateByPid.set(pid, { phase: "failed", reason: "session ended before debugpy connected" });
          } else {
            stateByPid.delete(pid);
          }
          settleByPid.get(pid)?.();
        }
        tree?.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("attach.showStatusBarItem")) {
        updateStatusBar();
      }
    }),
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("debugpy", {
      createDebugAdapterTracker(session) {
        const pid = session.configuration.processId;
        if (session.configuration.request !== "attach" || typeof pid !== "number") {
          return undefined;
        }
        return {
          onDidSendMessage: (m: { type: string; command?: string; success?: boolean; message?: string; event?: string; body?: { category?: string; output?: string } }) => {
            if (m.type === "response" && m.command === "attach") {
              if (m.success) {
                onAttached(session, pid);
              } else {
                stateByPid.set(pid, { phase: "failed", reason: m.message ?? "attach request rejected" });
                log(`pid ${pid}: attach rejected: ${m.message}`);
                settleByPid.get(pid)?.();
                tree?.refresh();
              }
            } else if (m.type === "event" && m.event === "output" && m.body?.output && settings().verbose) {
              log(`pid ${pid} [${m.body.category}] ${m.body.output.trimEnd()}`);
            }
          },
          onError: (e: Error) => log(`pid ${pid}: adapter error: ${e.message}`),
        };
      },
    }),
  );

  tree = new ProcessTree({
    log,
    attach: (p) => attachToProcess(p, runPreflight()),
    isActive: (pid) => activeByPid.has(pid),
    wasInjected: (pid) => injectedPids.has(pid),
    state: (pid) => stateByPid.get(pid),
    settings: () => {
      const s = settings();
      return { processFilter: s.processFilter, showHidden: s.showHidden, verbose: s.verbose };
    },
  });
  context.subscriptions.push(tree);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.text = "$(plug) Attach";
  statusItem.tooltip = "Attach the Python debugger to a running process (no launch.json)";
  statusItem.command = "attach.pickProcess";
  context.subscriptions.push(statusItem);
  updateStatusBar();
}

export function deactivate(): void {
  /* nothing to clean up */
}

function updateStatusBar(): void {
  if (!statusItem) {
    return;
  }
  if (settings().showStatusBar) {
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

interface ProcItem extends vscode.QuickPickItem {
  proc?: PythonProcess;
  action?: "connect" | "copy" | "showLog";
}

const REFRESH_BTN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("refresh"), tooltip: "Refresh process list" };
const SHOW_HIDDEN_BTN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("eye"), tooltip: "Show editor tooling processes too" };
const HIDE_HIDDEN_BTN: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("eye-closed"), tooltip: "Hide editor tooling processes" };

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function makeItem(p: PythonProcess): ProcItem {
  const target = displayTarget(p.parsed, p.cwd);
  const args = p.parsed.args.join(" ");
  const age = formatAge(p.ageSeconds);
  const descParts = [`pid ${p.pid}`];
  if (age) {
    descParts.push(age);
  }
  if (p.parsed.debugpyListen) {
    descParts.push(`$(broadcast) listening :${p.parsed.debugpyListen.port}`);
  }
  if (activeByPid.has(p.pid)) {
    descParts.push("$(debug) attached");
  } else if (injectedPids.has(p.pid)) {
    descParts.push("$(warning) attached before");
  }
  const detailParts: string[] = [];
  if (p.cwd) {
    detailParts.push(`cwd ${p.cwd}`);
  }
  if (p.exe) {
    detailParts.push(p.exe);
  }
  if (p.hiddenReason) {
    detailParts.push(`hidden: ${p.hiddenReason}`);
  }
  const icon = p.hidden ? "$(eye-closed)" : p.parsed.debugpyListen ? "$(debug-alt)" : "$(file-code)";
  return {
    label: `${icon} ${truncate(target, 60)}${args ? " " + truncate(args, 80) : ""}`,
    description: descParts.join(" · "),
    detail: detailParts.join("  —  "),
    proc: p,
  };
}

async function loadItems(showHidden: boolean): Promise<ProcItem[]> {
  const s = settings();
  let filter: RegExp | undefined;
  if (s.processFilter) {
    try {
      filter = new RegExp(s.processFilter);
    } catch (e) {
      vscode.window.showWarningMessage(`attach.processFilter is not a valid regex: ${e}`);
    }
  }
  const procs = await listPythonProcesses({ filter, log: s.verbose ? log : undefined });
  log(`found ${procs.length} python process(es), ${procs.filter((p) => p.hidden).length} hidden`);
  const visible = procs.filter((p) => showHidden || !p.hidden);
  const items: ProcItem[] = visible.map(makeItem);
  if (items.length === 0) {
    items.push({
      label: "$(info) No running Python processes found for your user",
      description: filter ? "(a processFilter is set)" : "",
      detail: "Start your script from any terminal or SSH session on this host, then refresh.",
    });
  }
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(radio-tower) Connect to a listening debugpy (host:port)…",
      detail: `For a script started with: ${listenCommand(s.defaultPort)}`,
      action: "connect",
    },
    {
      label: "$(clippy) Copy debug-ready launch command",
      detail: "Guaranteed path for any host, no gdb/ptrace needed",
      action: "copy",
    },
  );
  return items;
}

async function pickAndAttach(): Promise<void> {
  if (!isSupportedPlatform()) {
    const choice = await vscode.window.showErrorMessage(
      `Attach-by-PID works on Linux and macOS hosts only (this extension host is ${process.platform}). Open your Linux server with Remote-SSH, or connect to a listening debugpy.`,
      "Connect to host:port…",
    );
    if (choice) {
      await connectToListening();
    }
    return;
  }

  const preflight = runPreflight();
  log(describePreflight(preflight));

  let showHidden = settings().showHidden;
  const qp = vscode.window.createQuickPick<ProcItem>();
  qp.title = "Attach to Running Python Process";
  qp.placeholder = "Pick the process to debug — breakpoints you have set become live on attach";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  const refreshButtons = () => {
    qp.buttons = [REFRESH_BTN, showHidden ? HIDE_HIDDEN_BTN : SHOW_HIDDEN_BTN];
  };
  const refresh = async () => {
    qp.busy = true;
    try {
      qp.items = await loadItems(showHidden);
    } finally {
      qp.busy = false;
    }
  };
  refreshButtons();

  const picked = await new Promise<ProcItem | undefined>((resolve) => {
    qp.onDidTriggerButton(async (b) => {
      if (b === REFRESH_BTN) {
        await refresh();
      } else {
        showHidden = !showHidden;
        refreshButtons();
        await refresh();
      }
    });
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
    void refresh();
  });

  if (!picked) {
    return;
  }
  if (picked.action === "connect") {
    await connectToListening();
    return;
  }
  if (picked.action === "copy") {
    await copyListenCommand();
    return;
  }
  if (!picked.proc) {
    return;
  }
  await attachToProcess(picked.proc, preflight);
}

async function attachToProcess(p: PythonProcess, preflight: PreflightResult): Promise<void> {
  const label = path.basename(displayTarget(p.parsed, p.cwd));

  // Launched with `python -m debugpy --listen`: connect, don't inject.
  if (p.parsed.debugpyListen) {
    const { host, port } = p.parsed.debugpyListen;
    log(`pid ${p.pid} is listening on ${host}:${port}; connecting instead of injecting`);
    await startAttach({ kind: "connect", host, port, label });
    return;
  }

  const active = activeByPid.get(p.pid);
  if (active) {
    const choice = await vscode.window.showInformationMessage(
      `${label} (pid ${p.pid}) is already attached in "${active.name}".`,
      "Focus that session",
    );
    if (choice) {
      await vscode.commands.executeCommand("workbench.debug.action.focusCallStackView");
    }
    return;
  }
  if (injectedPids.has(p.pid)) {
    const choice = await vscode.window.showWarningMessage(
      `${label} (pid ${p.pid}) was attached earlier in this session. debugpy usually cannot re-attach to the same process after a disconnect (breakpoints won't hit). Restart the script for a clean attach, or launch it with "python -m debugpy --listen" which supports reconnecting.`,
      "Attach anyway",
    );
    if (choice !== "Attach anyway") {
      return;
    }
  }

  if (preflight.blockers.length > 0) {
    const b = preflight.blockers[0];
    const actions = b.fix ? ["Copy fix command", "Connect to host:port instead"] : ["Connect to host:port instead"];
    const choice = await vscode.window.showErrorMessage(`Cannot attach by PID: ${b.message}`, ...actions);
    if (choice === "Copy fix command") {
      await vscode.env.clipboard.writeText(b.fix);
      vscode.window.setStatusBarMessage(`$(check) Copied: ${b.fix}`, 5000);
    } else if (choice === "Connect to host:port instead") {
      await connectToListening();
    }
    return;
  }
  if (preflight.warnings.length > 0) {
    const w = preflight.warnings[0];
    const actions = w.fix ? ["Attach anyway", "Copy fix command"] : ["Attach anyway"];
    const choice = await vscode.window.showWarningMessage(w.message, { modal: false }, ...actions);
    if (choice === "Copy fix command") {
      await vscode.env.clipboard.writeText(w.fix);
      vscode.window.setStatusBarMessage(`$(check) Copied: ${w.fix}`, 5000);
      return;
    }
    if (choice !== "Attach anyway") {
      return;
    }
  }
  await startAttach({ kind: "pid", pid: p.pid, label });
}

async function onAttached(session: vscode.DebugSession, pid: number): Promise<void> {
  stateByPid.set(pid, { phase: "attached" });
  settleByPid.get(pid)?.();
  tree?.refresh();
  try {
    const r = (await session.customRequest("threads")) as { threads?: unknown[] };
    const n = r.threads?.length;
    stateByPid.set(pid, { phase: "attached", threads: n });
    log(`pid ${pid}: attached, ${n ?? "?"} thread(s) visible`);
    vscode.window.setStatusBarMessage(`$(check) Attached to pid ${pid} — ${n ?? "?"} thread(s). Pause stops threads running Python; blocked threads stop at their next Python line.`, 8000);
  } catch (e) {
    log(`pid ${pid}: attached (threads request failed: ${e})`);
  }
  tree?.refresh();
}

async function startAttach(target: AttachTarget): Promise<void> {
  const s = settings();
  const config = buildAttachConfig(target, s);
  log(`starting debug session: ${JSON.stringify(config)}`);
  const folder = vscode.workspace.workspaceFolders?.[0];
  vscode.window.setStatusBarMessage(`$(sync~spin) ${config.name}…`, 15000);
  let ok = false;
  try {
    ok = await vscode.debug.startDebugging(folder, config as vscode.DebugConfiguration);
  } catch (e) {
    log(`startDebugging threw: ${e}`);
  }
  if (ok) {
    log(`startDebugging accepted: ${config.name}`);
    if (target.kind === "pid") {
      void trackInjection(target.pid, config.name);
    } else {
      vscode.window.setStatusBarMessage(`$(check) ${config.name}`, 5000);
    }
  } else {
    log(`startDebugging failed: ${config.name}`);
    const choice = await vscode.window.showErrorMessage(
      `${config.name} did not start. The Debug Console usually shows debugpy's reason (gdb/ptrace errors, or the process exited).`,
      "Show Log",
    );
    if (choice === "Show Log") {
      output.show(true);
    }
  }
}

/** Notification that lives until debugpy inside the target has connected (or the session dies). */
async function trackInjection(pid: number, name: string): Promise<void> {
  if (stateByPid.get(pid)?.phase === "attached") {
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${name}: injecting debugpy…`, cancellable: true },
    async (progress, token) => {
      await new Promise<void>((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const st = stateByPid.get(pid);
          if (!st || st.phase !== "injecting") {
            return;
          }
          const secs = Math.round((Date.now() - started) / 1000);
          progress.report({
            message:
              Date.now() - started > INJECT_HINT_MS
                ? `${secs}s — still waiting for the process to accept the debugger. It must hold the GIL briefly; a process stuck in a native call may take a while. Cancel to give up.`
                : `${secs}s`,
          });
        }, 1000);
        const done = () => {
          clearInterval(timer);
          settleByPid.delete(pid);
          resolve();
        };
        settleByPid.set(pid, done);
        token.onCancellationRequested(() => {
          const s = activeByPid.get(pid);
          if (s) {
            void vscode.debug.stopDebugging(s);
          }
          done();
        });
        if (stateByPid.get(pid)?.phase !== "injecting") {
          done();
        }
      });
    },
  );
  const st = stateByPid.get(pid);
  if (st?.phase === "failed") {
    const choice = await vscode.window.showErrorMessage(`${name}: ${st.reason}. The Debug Console has debugpy's output.`, "Show Log");
    if (choice) {
      output.show(true);
    }
    stateByPid.delete(pid);
    tree?.refresh();
  }
}

// ---------------------------------------------------------------------------
// Other commands
// ---------------------------------------------------------------------------

async function connectToListening(): Promise<void> {
  const s = settings();
  const text = await vscode.window.showInputBox({
    title: "Connect to Listening debugpy",
    prompt: `host:port of a process started with: ${listenCommand(s.defaultPort)}`,
    value: `${s.defaultHost}:${s.defaultPort}`,
    validateInput: (v) => {
      const r = parseHostPort(v, s.defaultHost);
      return typeof r === "string" ? r : undefined;
    },
  });
  if (text === undefined) {
    return;
  }
  const r = parseHostPort(text, s.defaultHost);
  if (typeof r === "string") {
    return;
  }
  await startAttach({ kind: "connect", host: r.host, port: r.port, label: `${r.host}:${r.port}` });
}

async function copyListenCommand(): Promise<void> {
  const cmd = listenCommand(settings().defaultPort);
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(`Copied: ${cmd}  — run it in any terminal, then use "Attach: Connect to Listening debugpy".`);
}

async function checkReadiness(): Promise<void> {
  const r = runPreflight();
  const text = describePreflight(r);
  log(text);
  if (r.blockers.length === 0 && r.warnings.length === 0) {
    vscode.window.showInformationMessage(`Attach-by-PID is ready on this host (gdb: ${r.gdbPath ?? "n/a"}, ptrace_scope: ${r.ptraceScope ?? "n/a"}).`);
    return;
  }
  const first = r.blockers[0] ?? r.warnings[0];
  const choice = await (r.blockers.length > 0 ? vscode.window.showErrorMessage : vscode.window.showWarningMessage)(
    first.message,
    ...(first.fix ? ["Copy fix command"] : []),
    "Show Log",
  );
  if (choice === "Copy fix command") {
    await vscode.env.clipboard.writeText(first.fix);
    vscode.window.setStatusBarMessage(`$(check) Copied: ${first.fix}`, 5000);
  } else if (choice === "Show Log") {
    output.show(true);
  }
}
