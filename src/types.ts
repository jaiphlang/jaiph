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

export interface RuleDef {
  name: string;
  comments: string[];
  commands: string[];
  loc: SourceLoc;
}

export interface WorkflowDef {
  name: string;
  comments: string[];
  steps: WorkflowStepDef[];
  loc: SourceLoc;
}

export interface FunctionDef {
  name: string;
  comments: string[];
  commands: string[];
  loc: SourceLoc;
}

export type WorkflowStepDef =
  | {
      type: "ensure";
      ref: RuleRefDef;
      args?: string;
    }
  | {
      type: "run";
      workflow: WorkflowRefDef;
    }
  | {
      type: "prompt";
      raw: string;
      loc: SourceLoc;
      /** When set, capture prompt stdout into this variable name. */
      captureName?: string;
    }
  | {
      type: "shell";
      command: string;
      loc: SourceLoc;
    }
  | {
      type: "if_not_ensure_then_run";
      ensureRef: RuleRefDef;
      runWorkflows: WorkflowRefDef[];
    }
  | {
      type: "if_not_shell_then";
      condition: string;
      thenSteps: Array<
        | { type: "shell"; command: string; loc: SourceLoc }
        | { type: "run"; workflow: WorkflowRefDef }
      >;
    }
  | {
      type: "if_not_ensure_then_shell";
      ensureRef: RuleRefDef;
      commands: Array<{ command: string; loc: SourceLoc }>;
    };

export interface jaiphModule {
  filePath: string;
  /** Optional in-file workflow metadata (agent model, command, run options). */
  metadata?: WorkflowMetadata;
  imports: ImportDef[];
  exports: string[];
  rules: RuleDef[];
  functions: FunctionDef[];
  workflows: WorkflowDef[];
  /** Present only when parsing a *.test.jh file. */
  tests?: TestBlockDef[];
}

/** In-file workflow metadata (replaces config file for V1). */
export interface WorkflowMetadata {
  agent?: { defaultModel?: string; command?: string };
  run?: { debug?: boolean; logsDir?: string };
}

export interface CompileResult {
  outputPath: string;
  bash: string;
}

/** Step inside a test block. Only present when module is a test file (*.test.jh). */
export type TestStepDef =
  | { type: "test_shell"; command: string; loc: SourceLoc }
  | { type: "test_mock_prompt"; response: string; loc: SourceLoc }
  | { type: "test_run_workflow"; captureName: string; workflowRef: string; loc: SourceLoc }
  | { type: "test_expect_contain"; variable: string; substring: string; loc: SourceLoc };

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

