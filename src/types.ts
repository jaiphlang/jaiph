export interface SourceLoc {
  line: number;
  col: number;
}

export interface ImportDef {
  path: string;
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
  | { kind: "wildcard" };

export interface MatchArmDef {
  pattern: MatchPatternDef;
  body: string;
}

export interface MatchExprDef {
  subject: string;
  arms: MatchArmDef[];
  loc: SourceLoc;
}

export type ConstRhs =
  | { kind: "expr"; bashRhs: string }
  | { kind: "run_capture"; ref: WorkflowRefDef; args?: string; bareIdentifierArgs?: string[] }
  | { kind: "ensure_capture"; ref: RuleRefDef; args?: string; bareIdentifierArgs?: string[] }
  | {
      kind: "prompt_capture";
      raw: string;
      /** Body source: "string" (quoted literal), "identifier" (bare var ref), "triple_quoted" (""" block). */
      bodyKind?: "string" | "identifier" | "triple_quoted";
      /** Original identifier name when bodyKind is "identifier". */
      bodyIdentifier?: string;
      loc: SourceLoc;
      returns?: string;
    }
  | { kind: "run_inline_script_capture"; body: string; lang?: string; args?: string; bareIdentifierArgs?: string[] }
  | { kind: "match_expr"; match: MatchExprDef };

export type IfConditionDef =
  | { kind: "ensure"; ref: RuleRefDef; args?: string; bareIdentifierArgs?: string[] }
  | { kind: "run"; ref: WorkflowRefDef; args?: string; bareIdentifierArgs?: string[] };

/** RHS of `channel <- …` */
export type SendRhsDef =
  | { kind: "forward" }
  | { kind: "literal"; token: string }
  | { kind: "var"; bash: string }
  | { kind: "run"; ref: WorkflowRefDef; args?: string; bareIdentifierArgs?: string[] }
  /** Parsed then rejected in validation (use `run ref` to capture a return value). */
  | { kind: "bare_ref"; ref: WorkflowRefDef }
  /** Shell fragment emitted as `"$(...)"` for inbox send. */
  | { kind: "shell"; command: string; loc: SourceLoc };

export interface RuleDef {
  name: string;
  /** Named parameters declared on the rule definition (`()` means none). */
  params: string[];
  comments: string[];
  /** Rule body: Jaiph keywords plus shell fragments. */
  steps: WorkflowStepDef[];
  loc: SourceLoc;
}

export interface WorkflowRouteDef {
  channel: string;
  workflows: WorkflowRefDef[];
  loc: SourceLoc;
}

export interface ChannelDef {
  name: string;
  loc: SourceLoc;
}

export interface WorkflowDef {
  name: string;
  /** Named parameters declared on the workflow definition (`()` means none). */
  params: string[];
  comments: string[];
  steps: WorkflowStepDef[];
  routes?: WorkflowRouteDef[];
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
  /** How the body was provided: "backtick" (single `), "fenced" (``` block). */
  bodyKind: "backtick" | "fenced";
  loc: SourceLoc;
}

export type WorkflowStepDef =
  | {
      type: "ensure";
      ref: RuleRefDef;
      args?: string;
      bareIdentifierArgs?: string[];
      /** When set, capture step stdout into this variable name. */
      captureName?: string;
      /** When set, transpiles to for/seq bounded retry loop (break on success, exit 1 after max). */
      recover?:
        | { single: WorkflowStepDef }
        | { block: WorkflowStepDef[] };
    }
  | {
      type: "run";
      workflow: WorkflowRefDef;
      args?: string;
      bareIdentifierArgs?: string[];
      /** When set, capture step stdout into this variable name. */
      captureName?: string;
      /** When set, execute asynchronously with implicit join before workflow completes. */
      async?: boolean;
    }
  | {
      type: "prompt";
      raw: string;
      /** Body source: "string" (quoted literal), "identifier" (bare var ref), "triple_quoted" (""" block). */
      bodyKind?: "string" | "identifier" | "triple_quoted";
      /** Original identifier name when bodyKind is "identifier". */
      bodyIdentifier?: string;
      loc: SourceLoc;
      /** When set, capture prompt stdout into this variable name. */
      captureName?: string;
      /** When set, validate response JSON against this flat schema (field: string|number|boolean). */
      returns?: string;
    }
  | {
      type: "comment";
      text: string;
      loc: SourceLoc;
    }
  | {
      type: "fail";
      message: string;
      loc: SourceLoc;
    }
  | {
      type: "const";
      name: string;
      value: ConstRhs;
      loc: SourceLoc;
    }
  | {
      type: "wait";
      loc: SourceLoc;
    }
  | {
      type: "if";
      negated: boolean;
      condition: IfConditionDef;
      thenSteps: WorkflowStepDef[];
      /** Brace-style `else if` chain (parser-only; emits bash `elif`). */
      elseIfBranches?: Array<{
        negated: boolean;
        condition: IfConditionDef;
        thenSteps: WorkflowStepDef[];
      }>;
      elseSteps?: WorkflowStepDef[];
    }
  | {
      type: "log";
      message: string;
      loc: SourceLoc;
    }
  | {
      type: "logerr";
      message: string;
      loc: SourceLoc;
    }
  | {
      type: "send";
      channel: string;
      rhs: SendRhsDef;
      loc: SourceLoc;
    }
  | {
      type: "return";
      value: string;
      loc: SourceLoc;
      /** When set, return value comes from a managed run/ensure/match instead of the literal `value`. */
      managed?:
        | { kind: "run"; ref: WorkflowRefDef; args?: string; bareIdentifierArgs?: string[] }
        | { kind: "ensure"; ref: RuleRefDef; args?: string; bareIdentifierArgs?: string[] }
        | { kind: "match"; match: MatchExprDef };
    }
  | {
      type: "run_inline_script";
      body: string;
      /** Fence language tag (e.g. "node", "python3"). Maps to `#!/usr/bin/env <lang>`. */
      lang?: string;
      args?: string;
      bareIdentifierArgs?: string[];
      captureName?: string;
      loc: SourceLoc;
    }
  | {
      type: "shell";
      command: string;
      loc: SourceLoc;
      captureName?: string;
    }
  | {
      type: "match";
      expr: MatchExprDef;
    };

export interface EnvDeclDef {
  name: string;
  value: string;
  loc: SourceLoc;
}

export interface jaiphModule {
  filePath: string;
  /** Optional in-file workflow metadata (agent model, command, run options). */
  metadata?: WorkflowMetadata;
  imports: ImportDef[];
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
  dockerEnabled?: boolean;
  dockerImage?: string;
  dockerNetwork?: string;
  dockerTimeout?: number;
  workspace?: string[];
}

/** In-file workflow metadata (replaces config file for V1). */
export interface WorkflowMetadata {
  agent?: {
    defaultModel?: string;
    command?: string;
    backend?: "cursor" | "claude" | "codex";
    trustedWorkspace?: string;
    cursorFlags?: string;
    claudeFlags?: string;
  };
  run?: { debug?: boolean; logsDir?: string; inboxParallel?: boolean };
  runtime?: RuntimeConfig;
}

/** Step inside a test block. Only present when module is a test file (*.test.jh). */
export type TestStepDef =
  | { type: "test_shell"; command: string; loc: SourceLoc }
  | { type: "test_mock_prompt"; response: string; loc: SourceLoc }
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
  | { type: "test_expect_contain"; variable: string; substring: string; loc: SourceLoc }
  | { type: "test_expect_not_contain"; variable: string; substring: string; loc: SourceLoc }
  | { type: "test_expect_equal"; variable: string; expected: string; loc: SourceLoc }
  | { type: "test_mock_workflow"; ref: string; body: string; loc: SourceLoc }
  | { type: "test_mock_rule"; ref: string; body: string; loc: SourceLoc }
  | { type: "test_mock_script"; ref: string; body: string; loc: SourceLoc };

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
