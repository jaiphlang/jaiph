export function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  jaiph [--help | --version]",
      "  jaiph <file.jh> [args...]                # run workflow (same as jaiph run <file> [args...])",
      "  jaiph <file.test.jh> [args...]           # run tests (same as jaiph test <file>; extra args ignored)",
      "  jaiph run [--target <dir>] <file.jh> [--] [args...]",
      "  jaiph test [path]                        # workspace root, directory (recursive), or one *.test.jh file",
      "  jaiph init [workspace-path]",
      "  jaiph use <version|nightly>",
      "  jaiph format [--check] [--indent <n>] <file.jh ...>",
      "  jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...",
      "",
      "Global options (only as the first argument, before a subcommand or file path):",
      "  -h, --help     show this usage",
      "  -v, --version  show version",
      "",
      "jaiph run:",
      "  --target <dir>  keep emitted script files and run metadata under <dir> (default: temp dir, cleaned up)",
      "  --              end of jaiph flags; remaining args are passed to workflow default",
      "",
      "jaiph test:",
      "  With no path, discovers *.test.jh under the workspace root. Extra arguments after an optional",
      "  path are accepted but ignored (reserved).",
      "",
      "jaiph format:",
      "  --check         exit non-zero when file(s) need formatting (no writes)",
      "  --indent <n>    spaces per indent level (default: 2)",
      "",
      "jaiph compile:",
      "  Parse and validate (same as pre-run checks) without executing workflows. Useful for editors.",
      "  --json          stdout: JSON array of { file, line, col, code, message } (empty array if ok).",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect per file).",
      "",
      "Examples:",
      "  jaiph --help",
      "  jaiph --version",
      "  jaiph ./flows/review.jh 'review this diff'",
      "  jaiph e2e/say_hello.test.jh",
      "  jaiph run ./flows/review.jh 'review this diff'",
      "  jaiph run --target /tmp/jaiph-out ./flows/review.jh",
      "  jaiph test",
      "  jaiph test ./e2e",
      "  jaiph test e2e/say_hello.test.jh",
      "  jaiph init",
      "  jaiph use nightly",
      "  jaiph format flow.jh",
      "  jaiph format --check flow.jh",
      "  jaiph format --indent 4 flow.jh",
      "  jaiph compile flow.jh",
      "  jaiph compile --json .",
      "",
    ].join("\n"),
  );
}

export function parseArgs(args: string[]): { target?: string; raw?: boolean; positional: string[] } {
  let target: string | undefined;
  let raw: boolean | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--target") {
      const val = args[i + 1];
      if (!val) {
        throw new Error("--target requires a directory path");
      }
      target = val;
      i += 1;
      continue;
    }
    if (args[i] === "--raw") {
      raw = true;
      continue;
    }
    if (args[i] === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    positional.push(args[i]);
  }
  return { target, raw, positional };
}
