import * as vscode from "vscode";
import { execFile } from "child_process";

export class JaiphFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): Promise<vscode.TextEdit[]> {
    const config = vscode.workspace.getConfiguration("jaiph");
    const compilerPath = config.get<string>("compilerPath", "jaiph");
    const filePath = document.uri.fsPath;
    const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;

    const args = ["format", "--indent", String(options.tabSize), filePath];

    return new Promise<vscode.TextEdit[]>((resolve) => {
      execFile(compilerPath, args, { cwd, timeout: 15_000 }, (error, _stdout, stderr) => {
        if (error) {
          if (stderr) {
            vscode.window.showErrorMessage(`Jaiph format: ${stderr.trim()}`);
          }
          resolve([]);
          return;
        }

        // jaiph format writes in-place; re-read the file and diff
        const fs = require("fs") as typeof import("fs");
        try {
          const formatted = fs.readFileSync(filePath, "utf-8");
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length),
          );
          if (formatted !== document.getText()) {
            resolve([vscode.TextEdit.replace(fullRange, formatted)]);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
  }
}
