export function jaiphError(
  filePath: string,
  line: number,
  col: number,
  code: string,
  message: string,
): Error {
  return new Error(`${filePath}:${line}:${col} ${code} ${message}`);
}

/** Message text of an unknown thrown value: `.message` for Errors, `String()` otherwise. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
