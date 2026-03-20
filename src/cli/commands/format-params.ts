const MAX_PARAM_VALUE_DISPLAY = 32;

/** True if the param value is an internal symbol (impl ref, execute_readonly, prompt_impl) and should not be shown. */
export function isInternalParamValue(v: string): boolean {
  return (
    v.endsWith("::impl") ||
    v === "jaiph::execute_readonly" ||
    v === "jaiph::prompt_impl"
  );
}

/** If value looks like key=value, return only the value part; otherwise return as-is. */
function stripKeyPrefix(v: string): string {
  const match = v.match(/^[a-zA-Z_][a-zA-Z0-9_]*=(.*)$/s);
  return match ? match[1] : v;
}

/** Strip key= prefix from value using the known key name. */
function stripKnownKeyPrefix(key: string, value: string): string {
  const prefix = key + "=";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Collapse all whitespace (newlines, tabs, multiple spaces) into a single space and trim. */
export function normalizeParamValue(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

/** Map display key: argN → N, keep numeric keys as-is (no $ prefix), named keys unchanged. */
function displayKey(k: string): string {
  const argMatch = k.match(/^arg(\d+)$/);
  if (argMatch) return argMatch[1];
  return k;
}

/** Format params as key="value" pairs. Positional keys (argN or numeric) show as N="value". */
export function formatNamedParamsForDisplay(params: Array<[string, string]>, options?: { capTotalLength?: number }): string {
  const entries = params
    .filter(([, v]) => !isInternalParamValue(v))
    .map(([k, v]) => [k, stripKnownKeyPrefix(k, v)] as const)
    .filter(([, v]) => v.trim() !== "");
  if (entries.length === 0) return "";
  // Renumber positional (argN / numeric) keys sequentially after filtering.
  const allPositional = entries.every(([k]) => /^arg\d+$/.test(k) || /^[1-9]\d*$/.test(k));
  let positionalSeq = 1;
  const parts = entries.map(([k, v]) => {
    const normalized = normalizeParamValue(v);
    const visible =
      normalized.length > MAX_PARAM_VALUE_DISPLAY ? `${normalized.slice(0, MAX_PARAM_VALUE_DISPLAY)}...` : normalized;
    const escaped = visible.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const isPositional = /^arg\d+$/.test(k) || /^[1-9]\d*$/.test(k);
    const key = allPositional && isPositional ? String(positionalSeq++) : displayKey(k);
    return `${key}="${escaped}"`;
  });
  let result = ` (${parts.join(", ")})`;
  const cap = options?.capTotalLength;
  if (typeof cap === "number" && result.length > cap) {
    result = result.slice(0, cap - 3) + "...";
  }
  return result;
}

export function formatParamsForDisplay(params: Array<[string, string]>, options?: { capTotalLength?: number }): string {
  const values = params
    .map(([, v]) => v)
    .filter((v) => !isInternalParamValue(v))
    .map(stripKeyPrefix)
    .filter((v) => v.trim() !== "");
  if (values.length === 0) return "";
  const parts = values.map((v) => {
    const normalized = normalizeParamValue(v);
    const visible =
      normalized.length > MAX_PARAM_VALUE_DISPLAY ? `${normalized.slice(0, MAX_PARAM_VALUE_DISPLAY)}...` : normalized;
    const needsQuotes = /[\s,]/.test(visible) || visible.includes('"');
    const escaped = visible.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return needsQuotes ? `"${escaped}"` : visible;
  });
  let result = ` (${parts.join(", ")})`;
  const cap = options?.capTotalLength;
  if (typeof cap === "number" && result.length > cap) {
    result = result.slice(0, cap - 3) + "...";
  }
  return result;
}
