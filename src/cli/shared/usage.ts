import { ENV_KEY_RE, isReservedEnvKey } from "../../env-reserved";

export function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  jaiph [--help | --version]",
      "  jaiph <file.jh> [args...]                # run workflow (same as jaiph run <file> [args...])",
      "  jaiph <file.test.jh> [args...]           # run tests (same as jaiph test <file>; extra args ignored)",
      "  jaiph run [--target <dir>] [--raw] [--workspace <dir>] [--inplace] [--unsafe] [--yes|-y] [--env KEY[=VALUE]]... <file.jh> [--] [args...]",
      "  jaiph test [path]                        # workspace root, directory (recursive), or one *.test.jh file",
      "  jaiph init [workspace-path]",
      "  jaiph install [--force] [<name[@version]> | <repo-url[@version]> ...]",
      "  jaiph use <version|nightly>",
      "  jaiph format [--check] [--indent <n>] <file.jh ...>",
      "  jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...",
      "  jaiph mcp [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh>  # serve the file's workflows as MCP tools over stdio (alias: jaiph --mcp)",
      "",
      "Global options:",
      "  -h, --help     show this usage (jaiph --help) — each subcommand also accepts -h / --help",
      "  -v, --version  show version",
      "",
      "jaiph run:",
      "  --target <dir>     keep emitted script files and run metadata under <dir> (default: temp dir, cleaned up)",
      "  --raw              skip banner, progress tree, hooks, and failure footer; inherited stdio for embedding / Docker inner run",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect from the .jh file)",
      "  --inplace          bind-mount the host workspace rw so edits land live (sets JAIPH_INPLACE=1 for this run)",
      "  --unsafe           run on the host with no sandbox (sets JAIPH_UNSAFE=true for this run)",
      "  -y, --yes          skip the in-place confirmation prompt (sets JAIPH_INPLACE_YES=1 for this run)",
      "  --env KEY=VALUE    define KEY=VALUE in the workflow env (repeatable); --env KEY forwards the host value.",
      "                     In a Docker sandbox this is the per-key consent that crosses the env allowlist verbatim.",
      "  --                 end of jaiph flags; remaining args are passed to workflow default",
      "  Note: these flags only affect `jaiph run`; the corresponding env vars (JAIPH_INPLACE,",
      "  JAIPH_UNSAFE, JAIPH_INPLACE_YES) also apply to other entry points (e.g. `jaiph test`).",
      "",
      "jaiph test:",
      "  With no path, discovers *.test.jh under the workspace root. Extra arguments after an optional",
      "  path are accepted but ignored (reserved).",
      "",
      "jaiph install:",
      "  Args: bare names resolve via the registry; anything containing '/' or ':' is a git URL.",
      "  With one or more args: shallow-clone each repo into .jaiph/libs/<name>/ and update .jaiph/libs.lock.",
      "  With no args: restore all libraries listed in .jaiph/libs.lock (registry not contacted).",
      "  --force         delete existing clone and re-clone",
      "  JAIPH_REGISTRY  registry index path/URL (default: https://jaiph.org/registry).",
      "",
      "jaiph format:",
      "  --check         exit non-zero when file(s) need formatting (no writes)",
      "  --indent <n>    spaces per indent level (default: 2)",
      "",
      "jaiph compile:",
      "  Parse import closures and validateReferences only (same compile-time checks as before jaiph run;",
      "  no scripts/ emission, no buildRuntimeGraph, no runner). Useful for editors and CI.",
      "  -h, --help      show compile command usage (also accepted after jaiph compile)",
      "  --json          stdout: JSON array of { file, line, col, code, message } (empty array if ok).",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect per file).",
      "",
      "jaiph mcp:",
      "  Serve the file's workflows as MCP tools over stdio. Exposes `export workflow` declarations",
      "  if any exist, otherwise all top-level workflows except channel route targets; `default` is",
      "  exposed only when it is the only workflow, named after the file's basename. Tool descriptions",
      "  come from `#` comments directly above each workflow. Calls run on the host (like jaiph run --raw).",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect).",
      "  --env KEY=VALUE    define KEY in every tool call's env (repeatable); --env KEY forwards the host value.",
      "",
      "Examples:",
      "  jaiph --help",
      "  jaiph --version",
      "  jaiph ./flows/review.jh 'review this diff'",
      "  jaiph e2e/say_hello.test.jh",
      "  jaiph run ./flows/review.jh 'review this diff'",
      "  jaiph run --raw ./flows/review.jh",
      "  jaiph run --target /tmp/jaiph-out ./flows/review.jh",
      "  jaiph run --inplace --workspace ./app ./flows/fix.jh",
      "  jaiph run --unsafe ./flows/quick.jh",
      "  jaiph run --env GITHUB_TOKEN --env API_URL=https://x.test ./flows/deploy.jh",
      "  jaiph test",
      "  jaiph test ./e2e",
      "  jaiph test e2e/say_hello.test.jh",
      "  jaiph init",
      "  jaiph install jaiphlang",
      "  jaiph install mylib@v1.2",
      "  jaiph install https://github.com/you/queue-lib.git@v1.0",
      "  jaiph install",
      "  jaiph use nightly",
      "  jaiph format flow.jh",
      "  jaiph format --check flow.jh",
      "  jaiph format --indent 4 flow.jh",
      "  jaiph compile flow.jh",
      "  jaiph compile --json .",
      "  jaiph mcp ./tools.jh",
      "  jaiph mcp --env GITHUB_TOKEN ./tools.jh",
      "",
    ].join("\n"),
  );
}

/**
 * Returns true if any token before `--` is `-h` or `--help`.
 * Subcommands call this at the top of their entry function so help requests
 * never fall into positional / file-path resolution.
 */
export function hasHelpFlag(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "-h" || a === "--help") return true;
  }
  return false;
}

/**
 * One `--env` passthrough entry, collected in flag order.
 *  - `value` set        → `--env KEY=VALUE`: define KEY with that exact value.
 *  - `value` undefined  → `--env KEY`: forward the host's current value at
 *    spawn time (resolved by `resolveEnvPairs`, aborting with `E_ENV_MISSING`
 *    if KEY is unset on the host).
 */
export interface EnvSpec {
  key: string;
  value?: string;
}

// Name-shape and reserved-key policy is shared with the declarative
// `trusted_envs` config key (`src/parse/metadata.ts`) — see src/env-reserved.ts.
export { isReservedEnvKey };

/**
 * Parse one `--env` argument into an `EnvSpec`. Splits on the first `=` only,
 * so values may contain `=` and an empty value (`KEY=`) is allowed. Bare `KEY`
 * (no `=`) defers the host lookup to spawn time. Rejects invalid names
 * (`E_ENV_INVALID`) and reserved keys (`E_ENV_RESERVED`).
 */
function parseEnvSpec(raw: string): EnvSpec {
  const eq = raw.indexOf("=");
  const key = eq === -1 ? raw : raw.slice(0, eq);
  const value = eq === -1 ? undefined : raw.slice(eq + 1);
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `E_ENV_INVALID --env key "${key}" is not a valid environment variable name (must match [A-Za-z_][A-Za-z0-9_]*)`,
    );
  }
  if (isReservedEnvKey(key)) {
    throw new Error(
      `E_ENV_RESERVED --env cannot set reserved key "${key}"; use the sandbox flags (--inplace/--unsafe) or real env vars for control keys`,
    );
  }
  return value === undefined ? { key } : { key, value };
}

export interface ParsedArgs {
  target?: string;
  raw?: boolean;
  workspace?: string;
  inplace?: boolean;
  unsafe?: boolean;
  yes?: boolean;
  /** Repeatable `--env` passthrough entries, in flag order. */
  env: EnvSpec[];
  positional: string[];
}

export function parseArgs(args: string[]): ParsedArgs {
  let target: string | undefined;
  let raw: boolean | undefined;
  let workspace: string | undefined;
  let inplace: boolean | undefined;
  let unsafe: boolean | undefined;
  let yes: boolean | undefined;
  const env: EnvSpec[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    // Accept both `--flag value` and `--flag=value` for long options. Split on
    // the first `=` only, so values may themselves contain `=`.
    let name = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    // Value-taking flags: value comes from `=` or the next token.
    if (name === "--target" || name === "--workspace") {
      let val: string | undefined;
      if (inlineValue !== undefined) {
        val = inlineValue;
      } else {
        val = args[i + 1];
        i += 1;
      }
      if (!val) {
        throw new Error(`${name} requires a directory path`);
      }
      if (name === "--target") target = val;
      else workspace = val;
      continue;
    }

    // Repeatable `--env KEY` / `--env KEY=VALUE`. Value comes from `=` or the
    // next token; validation (name shape, reserved keys) happens now, but a
    // bare `KEY`'s host lookup is deferred to spawn time (resolveEnvPairs).
    if (name === "--env") {
      let val: string | undefined;
      if (inlineValue !== undefined) {
        val = inlineValue;
      } else {
        val = args[i + 1];
        i += 1;
      }
      if (val === undefined) {
        throw new Error(`--env requires a KEY or KEY=VALUE argument`);
      }
      env.push(parseEnvSpec(val));
      continue;
    }

    // Boolean flags: do not accept an `=value` form.
    if (name === "--raw" || name === "--inplace" || name === "--unsafe" || name === "--yes" || arg === "-y") {
      if (inlineValue !== undefined) {
        throw new Error(`${name} does not take a value`);
      }
      if (name === "--raw") raw = true;
      else if (name === "--inplace") inplace = true;
      else if (name === "--unsafe") unsafe = true;
      else yes = true;
      continue;
    }

    positional.push(arg);
  }
  return { target, raw, workspace, inplace, unsafe, yes, env, positional };
}
