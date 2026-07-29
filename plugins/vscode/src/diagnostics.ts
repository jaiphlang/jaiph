import * as vscode from "vscode";
import { execFile } from "child_process";

interface CompileDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

function toDiagnostic(err: CompileDiagnostic): vscode.Diagnostic {
  const line = Math.max(0, err.line - 1);
  const col = Math.max(0, err.col - 1);
  const range = new vscode.Range(line, col, line, col + 1);
  const diag = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
  diag.source = "jaiph";
  diag.code = err.code;
  return diag;
}

export async function runDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("jaiph");
  if (!config.get<boolean>("diagnostics.enabled", true)) return;

  const compilerPath = config.get<string>("compilerPath", "jaiph");
  const filePath = document.uri.fsPath;
  const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        compilerPath,
        ["compile", "--json", filePath],
        { cwd, timeout: 15_000 },
        (error, stdout, stderr) => {
          // compile exits non-zero on errors but still prints JSON to stdout
          if (stdout) {
            resolve(stdout);
          } else {
            reject(error ?? new Error(stderr));
          }
        },
      );
    });

    const errors: CompileDiagnostic[] = JSON.parse(stdout);
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const err of errors) {
      const uri = vscode.Uri.file(err.file).toString();
      if (!byFile.has(uri)) byFile.set(uri, []);
      byFile.get(uri)!.push(toDiagnostic(err));
    }

    collection.clear();
    for (const [uriStr, diags] of byFile) {
      collection.set(vscode.Uri.parse(uriStr), diags);
    }

    if (errors.length === 0) {
      collection.delete(document.uri);
    }
  } catch {
    // Compiler not found or crashed — silently ignore
  }
}
