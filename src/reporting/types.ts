export type RunDerivedStatus = "running" | "completed" | "failed";

export type StepRow = {
  id: string;
  parent_id: string | null;
  seq: number | null;
  depth: number | null;
  kind: string;
  name: string;
  func: string;
  params: Array<[string, string]>;
  status: number | null;
  elapsed_ms: number | null;
  out_file: string;
  err_file: string;
  out_content: string;
  err_content: string;
  /** True between STEP_START and STEP_END for this id. */
  running: boolean;
};

export type StepTreeNode = StepRow & { children: StepTreeNode[] };

export type RunListEntry = {
  relPath: string;
  run_id: string;
  source: string;
  started_at: string | null;
  ended_at: string | null;
  status: RunDerivedStatus;
  step_total: number;
  step_completed: number;
  step_running: number;
  has_failure: boolean;
};

export type ActiveRunInfo = {
  relPath: string;
  run_id: string;
  source: string;
  status: RunDerivedStatus;
  step_total: number;
  step_completed: number;
  step_running: number;
  percent: number | null;
  current_step_label: string | null;
};
