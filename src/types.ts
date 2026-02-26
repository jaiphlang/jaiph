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
    }
  | {
      type: "shell";
      command: string;
      loc: SourceLoc;
    }
  | {
      type: "if_not_ensure_then_run";
      ensureRef: RuleRefDef;
      runWorkflow: WorkflowRefDef;
    }
  | {
      type: "if_not_ensure_then_shell";
      ensureRef: RuleRefDef;
      commands: Array<{ command: string; loc: SourceLoc }>;
    };

export interface jaiphModule {
  filePath: string;
  imports: ImportDef[];
  exports: string[];
  rules: RuleDef[];
  functions: FunctionDef[];
  workflows: WorkflowDef[];
}

export interface CompileResult {
  outputPath: string;
  bash: string;
}
