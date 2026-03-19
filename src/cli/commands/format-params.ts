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

/** Format params as key="value" pairs. Positional numeric keys (1, 2, ...) are prefixed with $. */
export function formatNamedParamsForDisplay(params: Array<[string, string]>, options?: { capTotalLength?: number }): string {
  const entries = params
    .filter(([, v]) => !isInternalParamValue(v))
    .map(([k, v]) => [k, stripKnownKeyPrefix(k, v)] as const)
    .filter(([, v]) => v.trim() !== "");
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => {
    const visible =
      v.length > MAX_PARAM_VALUE_DISPLAY ? `${v.slice(0, MAX_PARAM_VALUE_DISPLAY)}...` : v;
    const escaped = visible.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const displayKey = /^[1-9]\d*$/.test(k) ? `$${k}` : k;
    return `${displayKey}="${escaped}"`;
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
    const visible =
      v.length > MAX_PARAM_VALUE_DISPLAY ? `${v.slice(0, MAX_PARAM_VALUE_DISPLAY)}...` : v;
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
