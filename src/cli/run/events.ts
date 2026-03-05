export type StepEvent = {
  type: "STEP_START" | "STEP_END";
  func: string;
  kind: string;
  name: string;
  ts: string;
  status: number | null;
  elapsed_ms: number | null;
  out_file: string;
  err_file: string;
  id: string;
  parent_id: string | null;
  seq: number | null;
  depth: number | null;
  run_id: string;
};

const PREFIX = "__JAIPH_EVENT__ ";

export function parseStepEvent(line: string): StepEvent | undefined {
  const markerIndex = line.indexOf(PREFIX);
  if (markerIndex === -1) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line.slice(markerIndex + PREFIX.length)) as Partial<StepEvent>;
    if (!parsed || (parsed.type !== "STEP_START" && parsed.type !== "STEP_END")) {
      return undefined;
    }
    if (typeof parsed.kind !== "string" || typeof parsed.name !== "string" || typeof parsed.func !== "string") {
      return undefined;
    }
    return {
      type: parsed.type,
      func: parsed.func,
      kind: parsed.kind,
      name: parsed.name,
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
      status: typeof parsed.status === "number" ? parsed.status : null,
      elapsed_ms: typeof parsed.elapsed_ms === "number" ? parsed.elapsed_ms : null,
      out_file: typeof parsed.out_file === "string" ? parsed.out_file : "",
      err_file: typeof parsed.err_file === "string" ? parsed.err_file : "",
      id: typeof parsed.id === "string" ? parsed.id : "",
      parent_id: typeof parsed.parent_id === "string" ? parsed.parent_id : null,
      seq: typeof parsed.seq === "number" ? parsed.seq : null,
      depth: typeof parsed.depth === "number" ? parsed.depth : null,
      run_id: typeof parsed.run_id === "string" ? parsed.run_id : "",
    };
  } catch {
    return undefined;
  }
}
