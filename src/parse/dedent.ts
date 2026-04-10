/**
 * Remove common leading whitespace from each line (same idea as Python `textwrap.dedent`).
 * Blank lines (empty or whitespace-only) do not affect the computed margin; whitespace-only
 * lines become empty in the output so the block can align with surrounding code indentation.
 */
export function dedentCommonLeadingWhitespace(text: string): string {
  const lines = text.split("\n");
  const nonBlank = lines.filter((l) => l.length > 0 && /\S/.test(l));
  let margin = 0;
  if (nonBlank.length > 0) {
    const l1 = nonBlank.reduce((a, b) => (a < b ? a : b));
    const l2 = nonBlank.reduce((a, b) => (a > b ? a : b));
    for (; margin < l1.length && margin < l2.length; margin++) {
      const c = l1[margin]!;
      if (c !== l2[margin] || (c !== " " && c !== "\t")) break;
    }
  }
  return lines
    .map((l) => {
      if (l.length > 0 && !/\S/.test(l)) {
        return "";
      }
      return l.slice(margin);
    })
    .join("\n");
}
