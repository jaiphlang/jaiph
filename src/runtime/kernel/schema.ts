// Schema validation for typed prompts (returns '{ field: type }').

type SchemaField = { name: string; type: string };

/**
 * Index just past the `}` that closes the `{` at `from`, ignoring braces inside
 * JSON string literals (`"…"` with backslash escapes); -1 if it never closes.
 */
function balancedObjectEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Try to extract a JSON object from the raw prompt response using multiple strategies. */
export function extractJson(raw: string): { obj: Record<string, unknown>; source: string } | null {
  const lines = raw.split(/\n/).filter((l) => l.trim().length > 0);
  const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
  const fence = "```";
  const fencedPattern = new RegExp(fence + "(?:json)?\\s*([\\s\\S]*?)" + fence, "gi");
  const fencedMatches = [...raw.matchAll(fencedPattern)];
  const fencedJson = fencedMatches.length > 0 ? String(fencedMatches[fencedMatches.length - 1][1] || "").trim() : "";
  const objectLine = [...lines].reverse().map((l) => l.trim()).find((l) => l.startsWith("{") && l.endsWith("}")) || "";
  const embeddedJson = (() => {
    for (const line of [...lines].reverse()) {
      const trimmed = line.trim();
      const startIdx = trimmed.indexOf("{");
      if (startIdx > 0) {
        const endIdx = trimmed.lastIndexOf("}");
        if (endIdx > startIdx) return trimmed.slice(startIdx, endIdx + 1);
      }
    }
    return "";
  })();
  // Scan lines from the end; on the first line holding a JSON object, take the
  // LONGEST object that parses. Prose before the answer can contain a small
  // parseable object (`{ }`, `{"a":1}`), and the answer itself can contain braces
  // inside string values, so: count braces outside JSON strings only, and prefer
  // the largest object on the line over the first one found.
  const balancedObject = (() => {
    for (const line of [...lines].reverse()) {
      const trimmed = line.trim();
      let best = "";
      for (let from = trimmed.indexOf("{"); from >= 0; from = trimmed.indexOf("{", from + 1)) {
        const end = balancedObjectEnd(trimmed, from);
        if (end < 0 || end - from <= best.length) continue;
        const slice = trimmed.slice(from, end);
        try {
          const o = JSON.parse(slice);
          if (typeof o === "object" && o !== null && !Array.isArray(o)) best = slice;
        } catch { /* not JSON; try the next "{" */ }
      }
      if (best) return best;
    }
    return "";
  })();

  const candidates = [balancedObject, lastLine, fencedJson, objectLine, embeddedJson]
    .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

  let parseError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        return { obj: obj as Record<string, unknown>, source: candidate };
      }
    } catch (e) {
      parseError = e as Error;
    }
  }

  if (parseError) {
    process.stderr.write(`jaiph: prompt returned invalid JSON (parse error): ${parseError.message}\n`);
    process.stderr.write(`Last line: ${lastLine.slice(0, 200)}${lastLine.length > 200 ? "..." : ""}\n`);
  } else {
    process.stderr.write("jaiph: prompt returned invalid JSON: root must be an object\n");
  }
  return null;
}

/** Validate fields against schema. Returns exit code (0=ok, 2=missing, 3=type mismatch). */
export function validateFields(
  obj: Record<string, unknown>,
  fields: SchemaField[],
): number {
  for (const f of fields) {
    if (!(f.name in obj)) {
      process.stderr.write(`jaiph: prompt response missing required field: ${f.name}\n`);
      return 2;
    }
  }
  for (const f of fields) {
    const v = obj[f.name];
    const t = f.type;
    if (t === "string" && typeof v !== "string") {
      process.stderr.write(`jaiph: prompt response field "${f.name}" expected string, got ${typeof v}\n`);
      return 3;
    }
    if (t === "number" && typeof v !== "number") {
      process.stderr.write(`jaiph: prompt response field "${f.name}" expected number, got ${typeof v}\n`);
      return 3;
    }
    if (t === "boolean" && typeof v !== "boolean") {
      process.stderr.write(`jaiph: prompt response field "${f.name}" expected boolean, got ${typeof v}\n`);
      return 3;
    }
  }
  return 0;
}
