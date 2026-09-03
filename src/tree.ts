import * as vscode from "vscode";
import { PythonProcess, listPythonProcesses, displayTarget, formatAge } from "./processes";
import type { AttachState } from "./extension";

export interface TreeDeps {
  log: (msg: string) => void;
  attach: (p: PythonProcess) => Promise<void>;
  isActive: (pid: number) => boolean;
  wasInjected: (pid: number) => boolean;
  state: (pid: number) => AttachState | undefined;
  settings: () => { processFilter: string; showHidden: boolean; verbose: boolean };
}

const REFRESH_MS = 4000;

export class ProcessItem extends vscode.TreeItem {
  constructor(public readonly proc: PythonProcess, active: boolean, injectedBefore: boolean, state: AttachState | undefined) {
    const target = displayTarget(proc.parsed, proc.cwd);
    const args = proc.parsed.args.join(" ");
    super(args ? `${target} ${args}` : target, vscode.TreeItemCollapsibleState.None);
    const bits = [`pid ${proc.pid}`];
    const age = formatAge(proc.ageSeconds);
    if (age) {
      bits.push(age);
    }
    if (proc.parsed.debugpyListen) {
      bits.push(`listening :${proc.parsed.debugpyListen.port}`);
    }
    if (active && state?.phase === "injecting") {
      bits.push("injecting debugpy…");
    } else if (active && state?.phase === "attached") {
      bits.push(state.threads !== undefined ? `attached · ${state.threads} threads` : "attached");
    } else if (state?.phase === "failed") {
      bits.push(`attach failed: ${state.reason}`);
    } else if (injectedBefore) {
      bits.push("attached before");
    }
    this.description = bits.join(" · ");
    const md = new vscode.MarkdownString();
    md.appendCodeblock(proc.cmdline.join(" "), "shell");
    if (proc.cwd) {
      md.appendMarkdown(`\n\ncwd: \`${proc.cwd}\``);
    }
    if (proc.exe) {
      md.appendMarkdown(`\n\ninterpreter: \`${proc.exe}\``);
    }
    if (proc.hiddenReason) {
      md.appendMarkdown(`\n\n_hidden by default: ${proc.hiddenReason}_`);
    }
    this.tooltip = md;
    this.iconPath = new vscode.ThemeIcon(
      active && state?.phase === "injecting"
        ? "sync~spin"
        : active
          ? "debug"
          : state?.phase === "failed"
            ? "error"
            : proc.hidden
              ? "eye-closed"
              : proc.parsed.debugpyListen
                ? "broadcast"
                : "file-code",
    );
    this.contextValue = active ? "process-attached" : "process";
    this.command = { command: "attach.attachItem", title: "Attach", arguments: [this] };
  }
}

export class ProcessTree implements vscode.TreeDataProvider<ProcessItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ProcessItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;
  private visible = false;
  private showHidden: boolean;
  private lastKey = "";
  readonly view: vscode.TreeView<ProcessItem>;

  constructor(private readonly deps: TreeDeps) {
    this.showHidden = deps.settings().showHidden;
    this.view = vscode.window.createTreeView("attach.processes", { treeDataProvider: this, showCollapseAll: false });
    this.view.onDidChangeVisibility((e) => {
      this.visible = e.visible;
      if (e.visible) {
        this.refresh();
        this.startTimer();
      } else {
        this.stopTimer();
      }
    });
    void vscode.commands.executeCommand("setContext", "attach.showHidden", this.showHidden);
  }

  toggleHidden(): void {
    this.showHidden = !this.showHidden;
    void vscode.commands.executeCommand("setContext", "attach.showHidden", this.showHidden);
    this.refresh();
  }

  refresh(): void {
    this.lastKey = "";
    this.emitter.fire(undefined);
  }

  /** Re-fire only when the process set changed, so the tree doesn't flicker. */
  private async poll(): Promise<void> {
    if (!this.visible) {
      return;
    }
    const procs = await this.list();
    const key = procs.map((p) => `${p.pid}:${this.deps.isActive(p.pid)}`).join(",");
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.emitter.fire(undefined);
    }
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => void this.poll(), REFRESH_MS);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async list(): Promise<PythonProcess[]> {
    const s = this.deps.settings();
    let filter: RegExp | undefined;
    if (s.processFilter) {
      try {
        filter = new RegExp(s.processFilter);
      } catch {
        /* reported by the picker */
      }
    }
    const procs = await listPythonProcesses({ filter, log: s.verbose ? this.deps.log : undefined });
    return procs.filter((p) => this.showHidden || !p.hidden);
  }

  async getChildren(element?: ProcessItem): Promise<ProcessItem[]> {
    if (element) {
      return [];
    }
    const procs = await this.list();
    this.lastKey = procs.map((p) => `${p.pid}:${this.deps.isActive(p.pid)}`).join(",");
    return procs.map((p) => new ProcessItem(p, this.deps.isActive(p.pid), this.deps.wasInjected(p.pid), this.deps.state(p.pid)));
  }

  getTreeItem(element: ProcessItem): vscode.TreeItem {
    return element;
  }

  dispose(): void {
    this.stopTimer();
    this.view.dispose();
    this.emitter.dispose();
  }
}
