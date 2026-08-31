import { ENV_KEY_RE, isReservedEnvKey } from "../../env-reserved";

export function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  jaiph [--help | --version]",
      "  jaiph <file.jh> [args...]                # run the file (same as jaiph run <file> [args...])",
      "  jaiph <file.test.jh> [args...]           # run tests (same as jaiph test <file>; extra args ignored)",
      "  jaiph run [--target <dir>] [--raw] [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh> [--] [args...]",
      "  jaiph test [path]                        # workspace root, directory (recursive), or one *.test.jh file",
      "  jaiph init [workspace-path]",
      "  jaiph install [--force] [<name[@version]> | <repo-url[@version]> ...]",
      "  jaiph use <version|nightly>",
      "  jaiph format [--check] [--indent <n>] <file.jh ...>",
      "  jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...",
      "  jaiph mcp [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh>  # serve the file's defs as MCP tools over stdio (alias: jaiph --mcp)",
      "  jaiph serve [--host <addr>] [--port <n>] [--workspace <dir>] [--allow-anonymous] [--env KEY[=VALUE]]... <file.jh>  # serve defs as an HTTP API + OpenAPI + Swagger UI",
      "",
      "Global options:",
      "  -h, --help     show this usage (jaiph --help) — each subcommand also accepts -h / --help",
      "  -v, --version  show version",
      "",
      "Shared flags (jaiph run, jaiph serve, jaiph mcp):",
      "  --workspace <dir> and --env KEY[=VALUE] mean the same thing in all three commands.",
      "  A flag belonging to another command is a usage error, never a silently-ignored option or a positional.",
      "",
      "jaiph run:",
      "  --target <dir>     keep emitted script files and run metadata under <dir> (default: temp dir, cleaned up)",
      "  --raw              skip banner, progress tree, hooks, and failure footer; inherited stdio for embedding",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect from the .jh file)",
      "  --env KEY=VALUE    define KEY=VALUE in the def env(repeatable); --env KEY forwards the host value.",
      "  --                 end of jaiph flags; remaining args are passed to def main",
      "",
      "jaiph test:",
      "  With no path, discovers *.test.jh under the workspace root. Extra arguments after an optional",
      "  path are accepted but ignored (reserved).",
      "  --env KEY[=VALUE]  grant KEY to matching script and named-prompt `use` clauses (no pre-flight:",
      "                     an ungranted `use` key is simply absent in the subprocess env).",
      "",
      "jaiph install:",
      "  Args: bare names resolve via the registry; anything containing '/' or ':' is a git URL.",
      "  With one or more args: shallow-clone each repo into .jaiph/libs/<name>/ and update .jaiph/libs.lock.",
      "  With no args: restore all libraries listed in .jaiph/libs.lock (registry not contacted).",
      "  --force         delete existing clone and re-clone",
      "  --allow-unpinned  install a registry entry that has no pinned commit (prints a warning)",
      "  JAIPH_REGISTRY  registry index path/URL (default: https://jaiph.org/registry).",
      "",
      "jaiph format:",
      "  --check         exit non-zero when file(s) need formatting (no writes)",
      "  --indent <n>    spaces per indent level (default: 2)",
      "",
      "jaiph compile:",
      "  Parse and validate import closures, collecting every compile-time error at once (jaiph run",
      "  stops at the first); no scripts/ emission, no buildRuntimeGraph, no runner. Useful for editors and CI.",
      "  -h, --help      show compile command usage (also accepted after jaiph compile)",
      "  --json          stdout: JSON array of { file, line, col, code, message } (empty array if ok).",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect per file).",
      "",
      "jaiph mcp:",
      "  Serve the file's exported defs as MCP tools over stdio. Skip `main` unless it is the",
      "  sole export; then expose it under the file's basename. Tool descriptions come from",
      "  `#` comments directly above each def.",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect).",
      "  --env KEY=VALUE    define KEY in every tool call's env (repeatable); --env KEY forwards the host value.",
      "",
      "jaiph serve:",
      "  Serve the file's defs as an HTTP API with a generated OpenAPI 3.1 document",
      "  and a self-contained Swagger UI at /docs (assets embedded — no browser internet",
      "  access needed). Exposure mirrors `jaiph mcp`. Runs are durable resources",
      "  under .jaiph/runs/: inspect one with GET /v1/runs/{id}, stream its event journal",
      "  (NDJSON or SSE) via GET /v1/runs/{id}/events, and list/download published files via",
      "  GET /v1/runs/{id}/artifacts[/{path}]. Set JAIPH_SERVE_TOKEN to",
      "  require a bearer token on /v1/*; binding a non-loopback --host without it is a",
      "  startup error. With no JAIPH_SERVE_TOKEN and no OIDC, even a loopback bind is a",
      "  startup error unless --allow-anonymous is passed (single-user workstation only).",
      "  JAIPH_SERVE_MAX_CONCURRENT (default 4) caps simultaneous runs.",
      "  --host <addr>      listen address (default: 127.0.0.1)",
      "  --port <n>         listen port (default: 5247)",
      "  --allow-anonymous  run open with no auth on loopback (single-user workstation only;",
      "                     every local user gets all capabilities over all runs). Ignored when",
      "                     JAIPH_SERVE_TOKEN or OIDC is set.",
      "  --workspace <dir>  workspace root for import resolution (default: auto-detect).",
      "  --env KEY=VALUE    define KEY in every run's env (repeatable); --env KEY forwards the host value.",
      "",
      "Examples:",
      "  jaiph --help",
      "  jaiph --version",
      "  jaiph ./flows/review.jh 'review this diff'",
      "  jaiph e2e/say_hello.test.jh",
      "  jaiph run ./flows/review.jh 'review this diff'",
      "  jaiph run --raw ./flows/review.jh",
      "  jaiph run --target /tmp/jaiph-out ./flows/review.jh",
      "  jaiph run --workspace ./app ./flows/fix.jh",
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
      "  jaiph serve ./tools.jh",
      "  JAIPH_SERVE_TOKEN=secret jaiph serve --host 0.0.0.0 --port 8080 ./tools.jh",
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

// Name-shape and reserved-key policy is shared with the `use` clause on
// script declarations (`src/parse/scripts.ts`) — see src/env-reserved.ts.
export { isReservedEnvKey };

/**
 * Resolve `--env` specs into a flat `KEY -> value` record, ready to apply to
 * the runner env. Must run **before** any process is spawned so a bare
 * `--env KEY` whose value is unset on the host aborts with `E_ENV_MISSING`
 * rather than silently dropping. Later duplicates win (flag order).
 * Name-shape and reserved-key rejection already happened at parse time
 * (`parseArgs`). The record's key set is also the `use` grant
 * (`JAIPH_ENV_GRANT`).
 */
export function resolveEnvPairs(
  specs: EnvSpec[],
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.value !== undefined) {
      out[spec.key] = spec.value;
    } else {
      const hostValue = hostEnv[spec.key];
      if (hostValue === undefined) {
        throw new Error(
          `E_ENV_MISSING --env ${spec.key}: no value given and ${spec.key} is not set on the host`,
        );
      }
      out[spec.key] = hostValue;
    }
  }
  return out;
}

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
      `E_ENV_RESERVED --env cannot set reserved key "${key}"; use real env vars for control keys`,
    );
  }
  return value === undefined ? { key } : { key, value };
}

export interface ParsedArgs {
  target?: string;
  raw?: boolean;
  workspace?: string;
  /** `jaiph serve` explicit opt-in to run open (anonymous) with no configured auth. */
  allowAnonymous?: boolean;
  /** `jaiph serve` listen host. */
  host?: string;
  /** `jaiph serve` listen port (kept as raw string; the command validates it). */
  port?: string;
  /** Repeatable `--env` passthrough entries, in flag order. */
  env: EnvSpec[];
  positional: string[];
}

/** Commands that share the execution-policy flag surface. */
export type CliCommand = "run" | "serve" | "mcp";

/**
 * Which commands accept each flag. `--workspace` and `--env` are shared by
 * all three commands; the rest are command-specific. A flag passed to a
 * command outside its row is a usage error, never a silently-ignored option
 * or a positional.
 */
const FLAG_COMMANDS: Record<string, CliCommand[]> = {
  "--workspace": ["run", "serve", "mcp"],
  "--env": ["run", "serve", "mcp"],
  "--target": ["run"],
  "--raw": ["run"],
  "--allow-anonymous": ["serve"],
  "--host": ["serve"],
  "--port": ["serve"],
};

/**
 * Reject a token that looks like a flag (`-…` before `--`) but is not accepted
 * by this command. Distinguishes "belongs to another command" (named in the
 * error) from "unknown everywhere", and points `jaiph run` users at `--` for
 * program arguments that begin with `-`.
 */
function rejectUnsupportedFlag(name: string, command: CliCommand): never {
  const owners = FLAG_COMMANDS[name];
  if (owners) {
    throw new Error(
      `${name} is not a jaiph ${command} flag (it belongs to ${owners.map((c) => `jaiph ${c}`).join(", ")}). ` +
        `Run \`jaiph ${command} --help\` for the supported flags.`,
    );
  }
  const passthroughHint =
    command === "run" ? " Use \`--\` before program arguments that start with \`-\`." : "";
  throw new Error(`unknown flag ${name} for jaiph ${command}.${passthroughHint}`);
}

export function parseArgs(args: string[], command: CliCommand = "run"): ParsedArgs {
  let target: string | undefined;
  let raw: boolean | undefined;
  let workspace: string | undefined;
  let allowAnonymous: boolean | undefined;
  let host: string | undefined;
  let port: string | undefined;
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

    // Every `-…` token before `--` must be a flag this command supports.
    // A bare `-` stays positional (conventional stdin marker).
    if (arg.startsWith("-") && arg !== "-" && !FLAG_COMMANDS[name]?.includes(command)) {
      rejectUnsupportedFlag(name, command);
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

    // `jaiph serve` listen address flags.
    if (name === "--host" || name === "--port") {
      let val: string | undefined;
      if (inlineValue !== undefined) {
        val = inlineValue;
      } else {
        val = args[i + 1];
        i += 1;
      }
      if (!val) {
        throw new Error(`${name} requires a value`);
      }
      if (name === "--host") host = val;
      else port = val;
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
    if (
      name === "--raw" ||
      name === "--allow-anonymous"
    ) {
      if (inlineValue !== undefined) {
        throw new Error(`${name} does not take a value`);
      }
      if (name === "--raw") raw = true;
      else allowAnonymous = true;
      continue;
    }

    positional.push(arg);
  }
  return { target, raw, workspace, allowAnonymous, host, port, env, positional };
}
