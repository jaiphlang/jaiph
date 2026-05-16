/**
 * Diagnostics collector — replaces fail-fast error reporting for the validator
 * (and any future call-site that wants to keep going after the first error).
 *
 * Two-tier model:
 * - **Recoverable** errors append to `Diagnostics.errors` and short-circuit the
 *   current validation unit via {@link BailoutError}. The unit's outer
 *   `diag.capture(...)` wrapper absorbs the bailout so the next unit (next
 *   step / next rule / next channel) still runs.
 * - **Fatal** errors continue to throw via `jaiphError` (parser-level cases
 *   where continuing would produce garbage AST — unterminated triple-quote,
 *   unterminated brace block, etc.). A fatal bit on the diagnostic record
 *   lets the CLI render them distinctly if needed.
 *
 * The collector also accepts errors that helpers still throw via the legacy
 * `jaiphError(file, line, col, code, msg)` shape: `capture()` parses such a
 * thrown error back into a `JaiphDiagnostic` and appends it. That keeps
 * helper signatures stable while still surfacing the full error set.
 */

import { jaiphError } from "./errors";

export interface JaiphDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
  fatal: boolean;
}

/** Sentinel thrown by `diag.error(...)` to unwind to the nearest capture boundary. */
export class BailoutError extends Error {
  readonly __jaiphBailout = true as const;
  constructor() {
    super("jaiph bailout");
  }
}

export function isBailout(err: unknown): err is BailoutError {
  return err instanceof Error && (err as { __jaiphBailout?: unknown }).__jaiphBailout === true;
}

/** Parse `path:line:col CODE message` (the shape `jaiphError` produces). */
export function diagnosticFromThrown(err: unknown, fatal = false): JaiphDiagnostic | null {
  if (!(err instanceof Error)) return null;
  if (isBailout(err)) return null;
  const m = err.message.match(/^(.+):(\d+):(\d+) (\S+) ([\s\S]+)$/);
  if (!m) return null;
  return {
    file: m[1],
    line: Number(m[2]),
    col: Number(m[3]),
    code: m[4],
    message: m[5].trimEnd(),
    fatal,
  };
}

export class Diagnostics {
  readonly errors: JaiphDiagnostic[] = [];

  add(d: JaiphDiagnostic): void {
    this.errors.push(d);
  }

  /**
   * Append a recoverable diagnostic and short-circuit the current validation
   * unit via `BailoutError`. The nearest `capture()` boundary absorbs the
   * bailout so the next sibling unit still runs.
   */
  error(file: string, line: number, col: number, code: string, message: string): never {
    this.errors.push({ file, line, col, code, message, fatal: false });
    throw new BailoutError();
  }

  /**
   * Run `fn`. Absorb `BailoutError`. Parse any thrown `jaiphError`-shape error
   * into a recoverable diagnostic. Re-throw anything else (likely an internal
   * bug we want to surface).
   */
  capture(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (isBailout(e)) return;
      const d = diagnosticFromThrown(e);
      if (d) {
        this.errors.push(d);
        return;
      }
      throw e;
    }
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  hasFatal(): boolean {
    return this.errors.some((d) => d.fatal);
  }

  /** Stable order: file, then line, then column. */
  sorted(): JaiphDiagnostic[] {
    return [...this.errors].sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      return a.col - b.col;
    });
  }

  /** One `file:line:col CODE message` line per diagnostic, in sorted order. */
  formatLines(): string[] {
    return this.sorted().map(
      (d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`,
    );
  }

  /**
   * Legacy bridge: throw the first sorted diagnostic as a regular `jaiphError`
   * so existing callers that depend on `validateReferences` throwing continue
   * to work. Does nothing when empty.
   */
  throwFirstIfAny(): void {
    if (this.errors.length === 0) return;
    const f = this.sorted()[0];
    throw jaiphError(f.file, f.line, f.col, f.code, f.message);
  }
}
