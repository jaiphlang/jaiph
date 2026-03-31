import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsejaiph } from "../../parser";
import { emitModule } from "../../format/emit";

export function runFormat(args: string[]): number {
  let check = false;
  let indent = 2;
  const files: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--check") {
      check = true;
      continue;
    }
    if (args[i] === "--indent") {
      const val = args[i + 1];
      if (!val || !/^[0-9]+$/.test(val)) {
        process.stderr.write("--indent requires a positive integer\n");
        return 1;
      }
      indent = Number(val);
      i += 1;
      continue;
    }
    files.push(args[i]);
  }

  if (files.length === 0) {
    process.stderr.write("Usage: jaiph format [--check] [--indent <n>] <file.jh ...>\n");
    return 1;
  }

  let needsChanges = false;

  for (const file of files) {
    const abs = resolve(file);
    if (!abs.endsWith(".jh")) {
      process.stderr.write(`format expects .jh files: ${file}\n`);
      return 1;
    }

    let source: string;
    try {
      source = readFileSync(abs, "utf-8");
    } catch {
      process.stderr.write(`cannot read file: ${file}\n`);
      return 1;
    }

    // Preserve shebang if present — the parser skips it but we need to re-emit it.
    const firstLine = source.split(/\r?\n/, 1)[0];
    const shebang = firstLine.startsWith("#!") ? firstLine : null;

    let mod;
    try {
      mod = parsejaiph(source, abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`parse error: ${msg}\n`);
      return 1;
    }

    let formatted = emitModule(mod, { indent });
    if (shebang) {
      formatted = shebang + "\n\n" + formatted;
    }

    if (check) {
      if (formatted !== source) {
        process.stderr.write(`${file}: needs formatting\n`);
        needsChanges = true;
      }
    } else {
      if (formatted !== source) {
        writeFileSync(abs, formatted, "utf-8");
      }
    }
  }

  return check && needsChanges ? 1 : 0;
}
