// JS kernel: schema validation for typed prompts (returns '{ field: type }').
// Schema validation for typed prompts.
// Called from bash: echo "$raw" | node kernel/schema.js
// Env: JAIPH_PROMPT_SCHEMA, JAIPH_PROMPT_CAPTURE_NAME
// Stdout: eval-able shell string setting capture var + per-field exports.
// Exit codes: 0=ok, 1=parse error, 2=missing field, 3=type mismatch.

import { readFileSync } from "node:fs";

type SchemaField = { name: string; type: string };

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
  const balancedObject = (() => {
    for (const line of [...lines].reverse()) {
      const trimmed = line.trim();
      let from = 0;
      while ((from = trimmed.indexOf("{", from)) >= 0) {
        let depth = 0;
        for (let i = from; i < trimmed.length; i++) {
          const c = trimmed[i];
          if (c === "{") depth++;
          else if (c === "}") {
            depth--;
            if (depth === 0) {
              const slice = trimmed.slice(from, i + 1);
              try {
                const o = JSON.parse(slice);
                if (typeof o === "object" && o !== null && !Array.isArray(o)) return slice;
              } catch { /* try next */ }
              break;
            }
          }
        }
        from++;
      }
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

/** Build eval-able shell string: captureName='json' ; export captureName_field='value' ... */
export function buildEvalString(
  obj: Record<string, unknown>,
  fields: SchemaField[],
  captureName: string,
  source: string,
): string {
  const esc = (s: string): string => String(s).replace(/'/g, "'\\''");
  let out = `${captureName}='${esc(source)}'`;
  for (const f of fields) {
    out += `; export ${captureName}_${f.name}='${esc(String(obj[f.name]))}'`;
  }
  return out;
}

// Main entry point when run as script
function main(): void {
  const raw = readFileSync(0, "utf8");
  const schemaStr = process.env.JAIPH_PROMPT_SCHEMA || "";
  const captureName = process.env.JAIPH_PROMPT_CAPTURE_NAME || "result";

  if (!schemaStr) {
    process.stderr.write("jaiph: prompt_capture_with_schema: JAIPH_PROMPT_SCHEMA must be set\n");
    process.exit(1);
  }

  const schema = JSON.parse(schemaStr) as { fields?: SchemaField[] };
  const fields = (schema.fields || []).map((f) => ({ name: f.name, type: f.type }));

  const extracted = extractJson(raw);
  if (!extracted) process.exit(1);

  const validationResult = validateFields(extracted.obj, fields);
  if (validationResult !== 0) process.exit(validationResult);

  process.stdout.write(buildEvalString(extracted.obj, fields, captureName, extracted.source));
}

if (require.main === module) {
  main();
}
