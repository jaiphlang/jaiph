import * as vscode from "vscode";
import { runCompile, CompileDiagnostic } from "./compile";

// Show the "compiler missing" error at most once until it is resolved, so a
// misconfigured PATH does not spam a popup on every save/open.
let configErrorShown = false;

function toDiagnostic(err: CompileDiagnostic): vscode.Diagnostic {
  const line = Math.max(0, err.line - 1);
  const col = Math.max(0, err.col - 1);
  const range = new vscode.Range(line, col, line, col + 1);
  const diag = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
  diag.source = "jaiph";
  diag.code = err.code;
  return diag;
}

function isCompilerPathConfigured(config: vscode.WorkspaceConfiguration): boolean {
  const inspected = config.inspect<string>("compilerPath");
  return Boolean(
    inspected?.globalValue || inspected?.workspaceValue || inspected?.workspaceFolderValue,
  );
}

export async function runDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("jaiph");
  if (!config.get<boolean>("diagnostics.enabled", true)) return;

  const compilerPath = config.get<string>("compilerPath", "jaiph");
  const result = await runCompile({
    compilerPath,
    filePath: document.uri.fsPath,
    cwd: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
    usingDefaultPath: !isCompilerPathConfigured(config),
  });

  if (result.kind === "config-error") {
    if (!configErrorShown) {
      configErrorShown = true;
      vscode.window.showErrorMessage(result.message);
    }
    return;
  }
  configErrorShown = false;

  // A transient failure (timeout, non-JSON output) leaves prior diagnostics in place.
  if (result.kind === "error") return;

  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const err of result.diagnostics) {
    const uri = vscode.Uri.file(err.file).toString();
    if (!byFile.has(uri)) byFile.set(uri, []);
    byFile.get(uri)!.push(toDiagnostic(err));
  }

  collection.clear();
  for (const [uriStr, diags] of byFile) {
    collection.set(vscode.Uri.parse(uriStr), diags);
  }
  if (result.diagnostics.length === 0) {
    collection.delete(document.uri);
  }
}
