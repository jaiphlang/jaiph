// Every Jaiph source in the repo, for whole-corpus property tests: tracked *.jh
// files, compiler-txtar valid inputs, e2e heredocs (`e2e::file "x.jh" <<'EOF'`),
// and ```jaiph / ```jh blocks in docs. Not every entry parses on its own (error
// examples, fragments); callers skip those.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

function gitFiles(...patterns: string[]): string[] {
  const out = execFileSync("git", ["ls-files", ...patterns], { cwd: REPO_ROOT }).toString().trim();
  return out ? out.split("\n") : [];
}

export function collectSources(): Array<[string, string]> {
  const sources: Array<[string, string]> = [];
  const read = (f: string): string => readFileSync(join(REPO_ROOT, f), "utf8");

  for (const f of gitFiles("*.jh")) sources.push([f, read(f)]);

  const txtar = read("test-fixtures/compiler-txtar/valid.txt");
  for (const block of txtar.split(/^=== /m).slice(1)) {
    const name = block.split("\n")[0];
    for (const fileBlock of block.split(/^--- /m).slice(1)) {
      const fileName = fileBlock.split("\n")[0].trim();
      if (fileName.endsWith(".jh")) {
        sources.push([`valid.txt: ${name}: ${fileName}`, fileBlock.slice(fileBlock.indexOf("\n") + 1)]);
      }
    }
  }

  const heredoc = /e2e::file\s+"([^"]+\.jh)"\s+<<'?(\w+)'?\n([\s\S]*?)\n\2\n/g;
  for (const f of gitFiles("e2e/tests/*.sh")) {
    for (const m of read(f).matchAll(heredoc)) sources.push([`${f}: ${m[1]}`, `${m[3]}\n`]);
  }

  const fenced = /```(?:jaiph|jh)\n([\s\S]*?)```/g;
  for (const f of gitFiles("docs/*.md", "README.md")) {
    let n = 0;
    for (const m of read(f).matchAll(fenced)) sources.push([`${f} block ${++n}`, m[1]]);
  }
  return sources;
}
