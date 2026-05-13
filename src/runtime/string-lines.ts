/**
 * Lines of a newline-delimited string for `for x in str`.
 * Normalizes `\r\n` to `\n`. If the string ends with a final newline, the
 * trailing empty segment is not yielded (so `"a\nb\n"` → `["a", "b"]`).
 */
export function linesOfDelimitedString(s: string): string[] {
  const normalized = s.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
