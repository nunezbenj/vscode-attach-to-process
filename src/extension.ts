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

let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem | undefined;
/** PIDs this extension host has injected into (debugpy cannot cleanly re-attach after a disconnect). */
const injectedPids = new Set<number>();
/** Active attach sessions keyed by PID. */
const activeByPid = new Map<number, vscode.DebugSession>();

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
    vscode.debug.onDidStartDebugSession((s) => {
      if (s.configuration.type === "debugpy" && s.configuration.request === "attach") {
        log(`session started: ${s.name}`);
        const pid = s.configuration.processId;
        if (typeof pid === "number") {
          injectedPids.add(pid);
          activeByPid.set(pid, s);
        }
      }
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.configuration.type === "debugpy" && s.configuration.request === "attach") {
        log(`session ended: ${s.name}`);
        const pid = s.configuration.processId;
        if (typeof pid === "number" && activeByPid.get(pid) === s) {
          activeByPid.delete(pid);
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("attach.showStatusBarItem")) {
        updateStatusBar();
      }
    }),
  );

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
    vscode.window.setStatusBarMessage(`$(check) ${config.name}`, 5000);
    log(`startDebugging accepted: ${config.name}`);
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
