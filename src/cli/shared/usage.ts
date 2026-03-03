export function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  jaiph build [--target <dir>] <path>",
      "  jaiph run [--target <dir>] <file.jh|file.jph> [args...]",
      "  jaiph test <file.jh|file.jph> [args...]",
      "  jaiph test [directory]   # discover and run *.test.jh",
      "  jaiph init [workspace-path]",
      "  jaiph use <version|nightly>",
      "",
      "Examples:",
      "  jaiph build ./",
      "  jaiph build --target ./build ./",
      "  jaiph run ./flows/review.jh 'review this diff'",
      "  jaiph test e2e/say_hello.jh",
      "  jaiph test .jaiph/main.jh \"implement feature X\"",
      "  jaiph init",
      "  jaiph use nightly",
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
