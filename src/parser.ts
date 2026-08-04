// Public parse API for code OUTSIDE the parse package. Per
// docs/agent-analyzability.md, outsiders import the parse slice only through
// this entry (src/parser.ts), never src/parse/** internals. The surface is
// re-exported explicitly — no `export *` barrel of the whole tree. The module
// scan itself lives in the private sibling `src/parse/parse-module.ts`.
//
// `parsejaiph` / `parsejaiphWithTrivia` are re-bound as writable `export const`
// data properties (not `export … from`, which compiles to a getter-only
// binding). Callers read them dynamically off this module's exports, and the
// pipeline purity tests spy on `parser.parsejaiph` by reassigning it — both need
// a writable property here.
import {
  parsejaiph as parsejaiphImpl,
  parsejaiphWithTrivia as parsejaiphWithTriviaImpl,
} from "./parse/parse-module";
export type { ParseResult } from "./parse/parse-module";
export const parsejaiph = parsejaiphImpl;
export const parsejaiphWithTrivia = parsejaiphWithTriviaImpl;
export { configValueHasInterpolation } from "./parse/metadata";
export {
  parseCallRef,
  matchSendOperator,
  isJaiphInterpolationRef,
  argsToRuntimeString,
} from "./parse/core";
export { createTrivia } from "./parse/trivia";
export type { NodeTrivia, Trivia } from "./parse/trivia";
export {
  scriptShebangIsBash,
  resolveInterpreterFromShebang,
} from "./parse/script-bash";
export { langToShebang } from "./parse/scripts";
export { canonicalizeTripleQuotedString } from "./parse/triple-quote";
export {
  validateJaiphStringContent,
  extractInlineCaptures,
} from "./parse/validate-string-content";
export type { InlineCapture } from "./parse/validate-string-content";
