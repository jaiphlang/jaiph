export interface SourceLoc {
  line: number;
  col: number;
}

export interface ImportDef {
  path: string;
  alias: string;
  loc: SourceLoc;
}

/** `import script "<path>" as <name>` — binds an external script file as a local script symbol. */
export interface ScriptImportDef {
  /** Relative path to the script file (as written in source). */
  path: string;
  /** Bound script name. */
  alias: string;
  loc: SourceLoc;
}

export interface RuleRefDef {
  value: string;
  loc: SourceLoc;
}

export interface WorkflowRefDef {
  value: string;
  loc: SourceLoc;
}

/** RHS of `const name = ...` in workflows/rules (P10). */
export type MatchPatternDef =
  | { kind: "string_literal"; value: string }
  | { kind: "regex"; source: string }
  | { kind: "wildcard" }
  /** `"a" | "b" | /^c/` — matches if any alternand matches. Never contains `wildcard` or nested `alternation` (parser-enforced). */
  | { kind: "alternation"; patterns: MatchPatternDef[] };

export interface MatchArmDef {
  pattern: MatchPatternDef;
  body: string;
  /** Arm body was parsed from `pattern => """ ... """` (runtime dedents margin; formatter keeps source). */
  tripleQuotedBody?: boolean;
}

export interface MatchExprDef {
  subject: string;
  arms: MatchArmDef[];
  loc: SourceLoc;
}

/**
 * Single call argument, classified at parse time.
 *
 * - `var`: a bare identifier or bare `IDENT.IDENT` reference
 *   (e.g. `foo(task)` → `{ kind: "var", name: "task" }`;
 *   `foo(result.role)` → `{ kind: "var", name: "result.role" }`).
 *   The validator checks `name` against in-scope bindings (or, for dotted names,
 *   against typed-prompt schemas); the runtime sees `${name}`.
 * - `literal`: any other form (quoted string, nested `run …` /
 *   `ensure …` / inline-script call, or illicit unquoted `${…}` which the
 *   validator rejects). Stored verbatim as authored, between the surrounding commas.
 */
export type Arg =
  | { kind: "literal"; raw: string }
  | { kind: "var"; name: string };

/**
 * One expression — used wherever a value can appear:
 * - `const name = <Expr>`
 * - `return <Expr>`
 * - `send channel <- <Expr>`
 * - `log <Expr>` / `logerr <Expr>` / `fail <Expr>`
 * - body of an `exec` step (managed call statement form, where the value is consumed
 *   for its side effects + optional capture)
 *
 * Replaces the prior `ConstRhs` / `SendRhsDef` unions and the placeholder-string
 * `managed:` sidecar on `return` / `log` / `logerr`.
 *
 * Kinds:
 * - `literal`: a string or `$var` / `${var}` form — the raw text as it appears in source
 *   (post-dedent for triple-quoted bodies; the formatter consults trivia for surface form).
 * - `call`: a managed workflow/script call `ref(args)`. `async` is set when the source said
 *   `run async ref(...)` in capture position.
 * - `ensure_call`: a managed rule call `ref(args)`.
 * - `inline_script`: an inline-script call (`` `body`(args) `` or fenced).
 * - `prompt`: a prompt body. `raw` carries the JSON-quoted prompt text (or `"${identifier}"`
 *   sugar). `returns` carries an optional flat returns schema.
 * - `match`: a `match <subject> { ... }` expression evaluated for its value.
 * - `shell`: a raw shell fragment used as a managed substitution on the send RHS.
 * - `bare_ref`: a bare symbol on a send RHS (e.g. `channel <- foo`). Always rejected by the
 *   validator; preserved so the error message can name the symbol.
 */
export type Expr =
  | { kind: "literal"; raw: string }
  | { kind: "call"; callee: WorkflowRefDef; args?: Arg[]; async?: boolean }
  | { kind: "ensure_call"; callee: RuleRefDef; args?: Arg[] }
  | { kind: "inline_script"; lang?: string; body: string; args?: Arg[] }
  | { kind: "prompt"; raw: string; loc: SourceLoc; returns?: string }
  | { kind: "match"; match: MatchExprDef }
  | { kind: "shell"; command: string; loc: SourceLoc }
  | { kind: "bare_ref"; ref: WorkflowRefDef };

/** Body attached to a `catch` or `recover` clause on an exec step. */
export type CatchBody =
  | { single: WorkflowStepDef; bindings: { failure: string } }
  | { block: WorkflowStepDef[]; bindings: { failure: string } };

export interface RuleDef {
  name: string;
  /** Named parameters declared on the rule definition (`()` means none). */
  params: string[];
  comments: string[];
  /** Rule body: Jaiph keywords plus shell fragments. */
  steps: WorkflowStepDef[];
  loc: SourceLoc;
}

export interface ChannelDef {
  name: string;
  routes?: WorkflowRefDef[];
  loc: SourceLoc;
}

export interface WorkflowDef {
  name: string;
  /** Named parameters declared on the workflow definition (`()` means none). */
  params: string[];
  comments: string[];
  steps: WorkflowStepDef[];
  /** Optional workflow-scoped config (overrides module-level config for steps inside this workflow). */
  metadata?: WorkflowMetadata;
  loc: SourceLoc;
}

export interface ScriptDef {
  name: string;
  comments: string[];
  /** Single string containing the entire script body. */
  body: string;
  /** Fence language tag (e.g. "python3", "node"). Maps to `#!/usr/bin/env <lang>`. */
  lang?: string;
  loc: SourceLoc;
}

/**
 * Eight workflow-step variants — all values that flow through a step live in `Expr`.
 *
 * - `exec`: side-effecting managed call statement (was: `run` / `ensure` /
 *   `run_inline_script` / `prompt` / `shell` step / standalone `match`). The
 *   discriminator now lives inside `body.kind`; `captureName` / `async` /
 *   `catch` / `recover` are step-level attributes.
 * - `const` / `return` / `send`: bind, propagate, or emit an `Expr` value.
 * - `say`: was `log` / `logerr` / `fail`. `level: "fail"` aborts the workflow
 *   with the message; otherwise the message is written to the corresponding
 *   stream.
 * - `if` / `for_lines`: control flow (unchanged shape).
 * - `trivia`: formatter-only `comment` / `blank_line` slots — they have no
 *   execution semantics and are skipped by the runtime / validator.
 */
export type WorkflowStepDef =
  | {
      type: "exec";
      body: Expr;
      /** When set, capture the result into this variable name. */
      captureName?: string;
      /** When set, catch failure and run recovery body once. */
      catch?: CatchBody;
      /** When set, retry with repair loop semantics (try → fail → recover body → retry). */
      recover?: CatchBody;
      loc: SourceLoc;
    }
  | {
      type: "const";
      name: string;
      value: Expr;
      loc: SourceLoc;
    }
  | {
      type: "return";
      value: Expr;
      loc: SourceLoc;
    }
  | {
      type: "send";
      channel: string;
      value: Expr;
      loc: SourceLoc;
    }
  | {
      type: "say";
      level: "log" | "logerr" | "logwarn" | "fail";
      message: Expr;
      loc: SourceLoc;
    }
  | {
      type: "if";
      subject: string;
      operator: "==" | "!=" | "=~" | "!~";
      operand: { kind: "string_literal"; value: string } | { kind: "regex"; source: string };
      body: WorkflowStepDef[];
      /** Optional `else { ... }` branch on `} else {`. */
      elseBody?: WorkflowStepDef[];
      loc: SourceLoc;
    }
  | {
      /** `for line in paths { ... }` — iterate lines of a string variable (newline-delimited). */
      type: "for_lines";
      iterVar: string;
      sourceVar: string;
      body: WorkflowStepDef[];
      loc: SourceLoc;
    }
  | {
      /** Formatter-only: `# comment` line or preserved blank line between steps. */
      type: "trivia";
      kind: "comment" | "blank_line";
      text?: string;
      loc?: SourceLoc;
    };

export interface EnvDeclDef {
  name: string;
  value: string;
  loc: SourceLoc;
  comments?: string[];
  /** True when the source value was written as a double-quoted string (single-line `"..."` or triple-quoted `"""..."""`). False/undefined for bare tokens. The formatter preserves this distinction so a quoted value stays quoted. */
  wasQuoted?: boolean;
}

/** Source order of definitions below imports / config / channels (formatter and round-trip). */
export type TopLevelEmitOrder =
  | { kind: "rule"; index: number }
  | { kind: "script"; index: number }
  | { kind: "workflow"; index: number }
  | { kind: "env"; index: number }
  | { kind: "test"; index: number };

export interface jaiphModule {
  filePath: string;
  /** Optional in-file workflow metadata (agent model, command, run options). */
  metadata?: WorkflowMetadata;
  imports: ImportDef[];
  /** `import script "<path>" as <name>` declarations. */
  scriptImports?: ScriptImportDef[];
  channels: ChannelDef[];
  exports: string[];
  rules: RuleDef[];
  scripts: ScriptDef[];
  workflows: WorkflowDef[];
  /** Top-level variable declarations (`const name = value`). */
  envDecls?: EnvDeclDef[];
  /** Present only when parsing a *.test.jh file. */
  tests?: TestBlockDef[];
}

/** Docker sandbox runtime configuration. */
export interface RuntimeConfig {
  dockerImage?: string;
  dockerNetwork?: string;
  dockerTimeoutSeconds?: number;
}

/** In-file workflow metadata (replaces config file for V1). */
export interface WorkflowMetadata {
  agent?: {
    model?: string;
    command?: string;
    backend?: "cursor" | "claude" | "codex";
    trustedWorkspace?: string;
    cursorFlags?: string;
    claudeFlags?: string;
  };
  run?: { debug?: boolean; logsDir?: string; recoverLimit?: number };
  runtime?: RuntimeConfig;
  module?: { name?: string; version?: string; description?: string };
}

/** Step inside a test block. Only present when module is a test file (*.test.jh). */
export type TestStepDef =
  | { type: "comment"; text: string; loc: SourceLoc }
  | { type: "blank_line" }
  /**
   * Literal string binding scoped to the enclosing test block:
   * `const expected = "..."`. The runner seeds test-scope vars with these
   * before mocks are collected, so subsequent `mock prompt <name>` and
   * `expect_* var <name>` references resolve to this value.
   */
  | { type: "test_const"; name: string; value: string; loc: SourceLoc }
  | {
      type: "test_mock_prompt";
      /** Literal response when authored as `mock prompt "..."`. Empty when responseVar is set. */
      response: string;
      /** Identifier when authored as `mock prompt <ident>` referring to a `test_const`. */
      responseVar?: string;
      loc: SourceLoc;
    }
  | {
      type: "test_mock_prompt_block";
      arms: MatchArmDef[];
      loc: SourceLoc;
    }
  | {
      type: "test_run_workflow";
      captureName?: string;
      workflowRef: string;
      args?: string[];
      allowFailure?: boolean;
      loc: SourceLoc;
    }
  | {
      type: "test_expect_contain";
      variable: string;
      substring: string;
      /** Set when authored as `expect_contain var <ident>`. */
      substringVar?: string;
      loc: SourceLoc;
    }
  | {
      type: "test_expect_not_contain";
      variable: string;
      substring: string;
      /** Set when authored as `expect_not_contain var <ident>`. */
      substringVar?: string;
      loc: SourceLoc;
    }
  | {
      type: "test_expect_equal";
      variable: string;
      expected: string;
      /** Set when authored as `expect_equal var <ident>`. */
      expectedVar?: string;
      loc: SourceLoc;
    }
  | { type: "test_mock_workflow"; ref: string; params: string[]; steps: WorkflowStepDef[]; loc: SourceLoc }
  | { type: "test_mock_rule"; ref: string; params: string[]; steps: WorkflowStepDef[]; loc: SourceLoc }
  | { type: "test_mock_script"; ref: string; params: string[]; body: string; loc: SourceLoc };

export interface TestBlockDef {
  description: string;
  steps: TestStepDef[];
  loc: SourceLoc;
}

export interface JaiphTestModule {
  filePath: string;
  imports: ImportDef[];
  tests: TestBlockDef[];
}

// --- Hooks (project/global .jaiph/hooks.json) ---

/** Supported hook event names for jaiph run lifecycle. */
export type HookEventName =
  | "workflow_start"
  | "workflow_end"
  | "step_start"
  | "step_end";

/** Schema for hooks.json: event name -> array of shell commands to run. */
export interface HookConfig {
  workflow_start?: string[];
  workflow_end?: string[];
  step_start?: string[];
  step_end?: string[];
}

/** Payload passed to hook commands (JSON on stdin). */
export interface HookPayload {
  event: HookEventName;
  /** Workflow run id (from runtime; empty for workflow_start until first step). */
  workflow_id: string;
  /** Step id (only for step_start/step_end). */
  step_id?: string;
  /** Step kind: workflow, rule, script, prompt. */
  step_kind?: string;
  /** Step name (e.g. default, scan_passes). */
  step_name?: string;
  /** Exit status (step_end: 0 = success; workflow_end: resolved status). */
  status?: number;
  /** ISO timestamp when event occurred. */
  timestamp: string;
  /** Elapsed ms for step (step_end) or total run (workflow_end). */
  elapsed_ms?: number;
  /** Absolute path to the workflow file being run. */
  run_path: string;
  /** Workspace root (project directory). */
  workspace: string;
  /** Run directory (logs); set for workflow_end and step_end when available. */
  run_dir?: string;
  /** Path to run_summary.jsonl; set for workflow_end when available. */
  summary_file?: string;
  /** Step stdout log path (step_end). */
  out_file?: string;
  /** Step stderr log path (step_end). */
  err_file?: string;
}
