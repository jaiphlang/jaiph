export function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  jaiph [--help | --version]",
      "  jaiph <file.jh> [args...]                # run workflow (same as jaiph run <file> [args...])",
      "  jaiph <file.test.jh>                     # run test file (same as jaiph test <file>)",
      "  jaiph build [--target <dir>] [path]      # compile .jh files; path defaults to .",
      "  jaiph run [--target <dir>] <file.jh> [--] [args...]",
      "  jaiph test [path]                        # workspace root, directory (recursive), or one *.test.jh file",
      "  jaiph init [workspace-path]",
      "  jaiph use <version|nightly>",
      "  jaiph report [start|stop|status] [--host <addr>] [--port <n>] [--poll-ms <n>] [--runs-dir <path>] [--workspace <path>] [--pid-file <path>]",
      "",
      "Global options (only as the first argument, before a subcommand or file path):",
      "  -h, --help     show this usage",
      "  -v, --version  show version",
      "",
      "Examples:",
      "  jaiph --help",
      "  jaiph --version",
      "  jaiph ./flows/review.jh 'review this diff'",
      "  jaiph e2e/say_hello.test.jh",
      "  jaiph build ./",
      "  jaiph build --target ./build ./",
      "  jaiph run ./flows/review.jh 'review this diff'",
      "  jaiph test",
      "  jaiph test ./e2e",
      "  jaiph test e2e/say_hello.test.jh",
      "  jaiph init",
      "  jaiph use nightly",
      "  jaiph report",
      "  jaiph report status",
      "  jaiph report stop",
      "",
    ].join("\n"),
  );
}

export function parseArgs(args: string[]): { target?: string; positional: string[] } {
  let target: string | undefined;
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
    if (args[i] === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    positional.push(args[i]);
  }
  return { target, positional };
}
