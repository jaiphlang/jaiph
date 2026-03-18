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
  /** Ordered list of [key, value] pairs for step parameters (workflow/prompt/function). */
  params: Array<[string, string]>;
  /** True when this step was dispatched by the inbox. */
  dispatched: boolean;
  /** Inbox channel name when dispatched. */
  channel: string;
};

export type LogEvent = {
  type: "LOG";
  message: string;
  depth: number;
};

const PREFIX = "__JAIPH_EVENT__ ";

export function parseLogEvent(line: string): LogEvent | undefined {
  const markerIndex = line.indexOf(PREFIX);
  if (markerIndex === -1) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line.slice(markerIndex + PREFIX.length)) as Record<string, unknown>;
    if (!parsed || parsed.type !== "LOG") {
      return undefined;
    }
    return {
      type: "LOG",
      message: typeof parsed.message === "string" ? parsed.message : "",
      depth: typeof parsed.depth === "number" ? parsed.depth : 0,
    };
  } catch {
    return undefined;
  }
}

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
    const paramsRaw = parsed.params;
    let params: Array<[string, string]> = [];
    if (Array.isArray(paramsRaw)) {
      for (const entry of paramsRaw) {
        if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === "string" && typeof entry[1] === "string") {
          params.push([entry[0], entry[1]]);
        }
      }
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
      params,
      dispatched: (parsed as Record<string, unknown>).dispatched === true,
      channel: typeof (parsed as Record<string, unknown>).channel === "string" ? (parsed as Record<string, unknown>).channel as string : "",
    };
  } catch {
    return undefined;
  }
}
