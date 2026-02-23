export function jaiphError(
  filePath: string,
  line: number,
  col: number,
  code: string,
  message: string,
): Error {
  return new Error(`${filePath}:${line}:${col} ${code} ${message}`);
}
