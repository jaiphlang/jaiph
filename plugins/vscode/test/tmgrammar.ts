// Minimal headless TextMate tokenizer used by the grammar tests. Loads the
// shipped jaiph.tmLanguage.json with vscode-textmate + vscode-oniguruma (the
// same engine VS Code uses) so scope assertions match real editor behaviour.
import * as fs from "fs";
import * as path from "path";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";

const ROOT = path.join(__dirname, "..", "..");
const GRAMMAR_PATH = path.join(ROOT, "syntaxes", "jaiph.tmLanguage.json");
const FIXTURES_DIR = path.join(ROOT, "test", "fixtures");

export interface Token {
  text: string;
  scopes: string[];
}

let grammarPromise: Promise<vsctm.IGrammar> | null = null;

function loadGrammar(): Promise<vsctm.IGrammar> {
  if (grammarPromise) return grammarPromise;
  const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
  const onigLib = oniguruma.loadWASM(wasm.buffer).then(() => ({
    createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
    createOnigString: (s: string) => new oniguruma.OnigString(s),
  }));
  const registry = new vsctm.Registry({
    onigLib,
    loadGrammar: async (scopeName: string) => {
      if (scopeName === "source.jaiph") {
        return vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, "utf8"), GRAMMAR_PATH);
      }
      // Embedded languages (python, shell, …) are not needed for jaiph-scope
      // assertions; returning null lets textmate skip them gracefully.
      return null;
    },
  });
  grammarPromise = registry.loadGrammar("source.jaiph").then((g) => {
    if (!g) throw new Error("failed to load source.jaiph grammar");
    return g;
  });
  return grammarPromise;
}

/** Tokenize a fixture file, returning one flat list of tokens across all lines. */
export async function tokenizeFixture(fixtureName: string): Promise<Token[]> {
  const grammar = await loadGrammar();
  const text = fs.readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf8");
  const lines = text.split(/\r?\n/);
  let ruleStack = vsctm.INITIAL;
  const tokens: Token[] = [];
  for (const line of lines) {
    const result = grammar.tokenizeLine(line, ruleStack);
    for (const t of result.tokens) {
      tokens.push({ text: line.substring(t.startIndex, t.endIndex), scopes: t.scopes });
    }
    ruleStack = result.ruleStack;
  }
  return tokens;
}

/** True if any token whose trimmed text equals `text` carries `scope`. */
export function hasScope(tokens: Token[], text: string, scope: string): boolean {
  return tokens.some((t) => t.text.trim() === text && t.scopes.includes(scope));
}
