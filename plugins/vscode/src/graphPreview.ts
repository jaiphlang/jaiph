import * as path from "path";
import * as vscode from "vscode";
import {
  DEFAULT_GRAPH_PREVIEW_OPTIONS,
  GraphPreviewOptions,
  listDefNames,
  runGraph,
} from "./graph";

export const GRAPH_PREVIEW_VIEW_TYPE = "jaiph.graphPreview";

/** What the webview keeps in its state so a reloaded window can restore it. */
interface PersistedState {
  uri: string;
  options: GraphPreviewOptions;
}

/** Messages the webview posts back to the extension. */
type FromWebview =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "options"; options: GraphPreviewOptions }
  | { type: "openSource" };

function isCompilerPathConfigured(config: vscode.WorkspaceConfiguration): boolean {
  const inspected = config.inspect<string>("compilerPath");
  return Boolean(
    inspected?.globalValue || inspected?.workspaceValue || inspected?.workspaceFolderValue,
  );
}

function isGraphable(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith(".jh") && !uri.fsPath.endsWith(".test.jh");
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

class GraphPreview {
  private options: GraphPreviewOptions;
  private seq = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly uri: vscode.Uri,
    options: GraphPreviewOptions,
    private readonly extensionUri: vscode.Uri,
    onDispose: () => void,
  ) {
    this.options = { ...options };
    panel.title = `Graph: ${path.basename(uri.fsPath)}`;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist"), vscode.Uri.joinPath(extensionUri, "media")],
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg)),
      panel.onDidDispose(() => {
        for (const d of this.disposables) d.dispose();
        onDispose();
      }),
    );
  }

  private onMessage(msg: FromWebview): void {
    switch (msg.type) {
      case "ready":
      case "refresh":
        void this.render();
        return;
      case "options":
        this.options = { ...msg.options };
        void this.render();
        return;
      case "openSource":
        void vscode.window.showTextDocument(this.uri, { viewColumn: vscode.ViewColumn.One });
        return;
    }
  }

  /** Re-run `jaiph graph` on the saved file and push the result to the webview. */
  async render(): Promise<void> {
    const seq = ++this.seq;
    let defs: string[] = [];
    try {
      const doc = await vscode.workspace.openTextDocument(this.uri);
      defs = listDefNames(doc.getText());
    } catch {
      // The file may have been deleted; the CLI reports that below.
    }
    if (defs.length > 0 && !defs.includes(this.options.def)) {
      this.options.def = defs.includes("main") ? "main" : defs[0];
    }

    const config = vscode.workspace.getConfiguration("jaiph");
    const compilerPath = config.get<string>("compilerPath", "jaiph");
    const result = await runGraph({
      compilerPath,
      filePath: this.uri.fsPath,
      options: this.options,
      cwd: vscode.workspace.getWorkspaceFolder(this.uri)?.uri.fsPath ?? path.dirname(this.uri.fsPath),
      usingDefaultPath: !isCompilerPathConfigured(config),
    });
    if (seq !== this.seq) return; // a newer render superseded this one

    const state: PersistedState = { uri: this.uri.toString(), options: this.options };
    const base = { defs, options: this.options, state, file: path.basename(this.uri.fsPath) };
    if (result.kind === "ok") {
      void this.panel.webview.postMessage({ type: "graph", mermaid: result.mermaid, ...base });
    } else {
      void this.panel.webview.postMessage({ type: "error", message: result.message, ...base });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "mermaid.min.js"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "graph-preview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "graph-preview.css"));
    const n = nonce();
    // Mermaid injects <style> into each SVG, so inline styles must be allowed.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${n}'`,
    ].join("; ");
    const limitOptions = (max: number) =>
      [...Array(max + 1).keys()].map((i) => `<option value="${i}">${i}</option>`).join("") +
      `<option value="all">all</option>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Jaiph graph</title>
</head>
<body>
<header class="toolbar">
  <label>Def <select id="def" title="Entry def to graph (--def)"></select></label>
  <label title="Def-call levels drawn below the entry def (--depth)">Depth <select id="depth">${limitOptions(10)}</select></label>
  <label title="Import hops whose defs are drawn (--import-depth)">Imports <select id="importDepth">${limitOptions(5)}</select></label>
  <label title="Also draw library defs from .jaiph/libs/ (--libs)"><input type="checkbox" id="libs"> Libs</label>
  <span class="spacer"></span>
  <button id="zoomOut" title="Zoom out">−</button>
  <button id="zoomFit" title="Fit to width">Fit</button>
  <button id="zoomIn" title="Zoom in">+</button>
  <button id="refresh" title="Re-run jaiph graph">Refresh</button>
  <button id="source" title="Open the source file">Source</button>
</header>
<main id="canvas"><p class="status">Loading graph…</p></main>
<script nonce="${n}" src="${mermaidUri}"></script>
<script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel.dispose();
  }
}

export class GraphPreviewManager implements vscode.WebviewPanelSerializer {
  private readonly previews = new Map<string, GraphPreview>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Open (or reveal) the graph preview for `uri`. */
  show(uri: vscode.Uri | undefined, column: vscode.ViewColumn): void {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || !isGraphable(target)) {
      void vscode.window.showWarningMessage("Jaiph graph preview needs a .jh file (not *.test.jh).");
      return;
    }
    const existing = this.previews.get(target.toString());
    if (existing) {
      existing.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(GRAPH_PREVIEW_VIEW_TYPE, "Jaiph graph", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.track(panel, target, DEFAULT_GRAPH_PREVIEW_OPTIONS);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const s = state as Partial<PersistedState> | undefined;
    if (!s?.uri) {
      panel.dispose();
      return;
    }
    this.track(panel, vscode.Uri.parse(s.uri), { ...DEFAULT_GRAPH_PREVIEW_OPTIONS, ...s.options });
  }

  /** Re-render every open preview (a saved import can change any of them). */
  refreshAll(): void {
    for (const p of this.previews.values()) void p.render();
  }

  dispose(): void {
    for (const p of [...this.previews.values()]) p.dispose();
  }

  private track(panel: vscode.WebviewPanel, uri: vscode.Uri, options: GraphPreviewOptions): void {
    const key = uri.toString();
    const preview = new GraphPreview(panel, uri, options, this.extensionUri, () => this.previews.delete(key));
    this.previews.set(key, preview);
  }
}
