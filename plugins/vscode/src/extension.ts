import * as vscode from "vscode";
import { runDiagnostics } from "./diagnostics";
import { JaiphFormattingProvider } from "./formatting";
import { GRAPH_PREVIEW_VIEW_TYPE, GraphPreviewManager } from "./graphPreview";

const LANGUAGE_ID = "jaiph";

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext): void {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
  context.subscriptions.push(diagnosticCollection);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === LANGUAGE_ID) {
        runDiagnostics(doc, diagnosticCollection);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === LANGUAGE_ID) {
        runDiagnostics(doc, diagnosticCollection);
      }
    }),
  );

  // Run on all already-open jaiph files
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === LANGUAGE_ID) {
      runDiagnostics(doc, diagnosticCollection);
    }
  }

  // Graph preview (like Markdown's "Open Preview"): renders `jaiph graph`.
  const graphPreviews = new GraphPreviewManager(context.extensionUri);
  context.subscriptions.push(
    { dispose: () => graphPreviews.dispose() },
    vscode.window.registerWebviewPanelSerializer(GRAPH_PREVIEW_VIEW_TYPE, graphPreviews),
    vscode.commands.registerCommand("jaiph.showGraphPreview", (uri?: vscode.Uri) =>
      graphPreviews.show(uri, vscode.ViewColumn.Active),
    ),
    vscode.commands.registerCommand("jaiph.showGraphPreviewToSide", (uri?: vscode.Uri) =>
      graphPreviews.show(uri, vscode.ViewColumn.Beside),
    ),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === LANGUAGE_ID) graphPreviews.refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("jaiph.compilerPath")) graphPreviews.refreshAll();
    }),
  );

  // Register formatting provider
  const formatter = new JaiphFormattingProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: LANGUAGE_ID },
      formatter,
    ),
  );
}

export function deactivate(): void {
  diagnosticCollection?.dispose();
}
