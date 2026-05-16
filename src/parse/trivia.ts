import type { TopLevelEmitOrder } from "../types";

/** One line inside `config { }`: comment or assignment (formatter round-trip order). */
export type ConfigBodyPart =
  | { kind: "comment"; text: string }
  | { kind: "assign"; key: string };

/**
 * Per-node source-fidelity data. Each field is optional; presence indicates a
 * particular surface form chosen by the author that the formatter needs to
 * round-trip. The validator/emitter never look at this map.
 *
 * - `tripleQuoted`: the literal/return/log/logerr/fail/send/const was written
 *   as `"""..."""`. The AST string is the *dedented* form (so runtime &
 *   validator don't need this flag); the original raw body is in `rawBody`.
 * - `rawBody`: original triple-quoted body (without surrounding `"""`), used
 *   by the formatter to re-emit the author's exact indentation.
 * - `bareSource`: `return foo` and `return foo.bar` sugar — formatter
 *   re-emits the bare form instead of `"${foo}"`.
 * - `bodyKind` (prompt): `"string" | "identifier" | "triple_quoted"`.
 * - `bodyIdentifier` (prompt): identifier name when `bodyKind === "identifier"`.
 * - `scriptBodyKind` (script): `"backtick" | "fenced"`.
 * - `leadingComments`: `#` lines immediately before an import / channel /
 *   test block / env decl.
 */
export interface NodeTrivia {
  tripleQuoted?: boolean;
  rawBody?: string;
  bareSource?: string;
  bodyKind?: "string" | "identifier" | "triple_quoted";
  bodyIdentifier?: string;
  scriptBodyKind?: "backtick" | "fenced";
  leadingComments?: string[];
  /** Order and comment lines inside `config { … }`; keyed on the metadata object. */
  configBodySequence?: ConfigBodyPart[];
}

/** Module-level source-fidelity data not tied to a specific node. */
export interface ModuleTrivia {
  configLeadingComments?: string[];
  configBodySequence?: ConfigBodyPart[];
  trailingTopLevelComments?: string[];
  topLevelOrder?: TopLevelEmitOrder[];
}

/**
 * Trivia store. The parser builds it alongside the semantic AST and returns
 * both via `parsejaiph`. The formatter reads it; nobody else does.
 */
export class Trivia {
  private nodes = new WeakMap<object, NodeTrivia>();
  private moduleData: ModuleTrivia = {};

  setNode(node: object, info: NodeTrivia): void {
    const existing = this.nodes.get(node);
    if (existing) {
      Object.assign(existing, info);
    } else {
      this.nodes.set(node, { ...info });
    }
  }

  getNode(node: object): NodeTrivia | undefined {
    return this.nodes.get(node);
  }

  setModule(info: Partial<ModuleTrivia>): void {
    Object.assign(this.moduleData, info);
  }

  getModule(): ModuleTrivia {
    return this.moduleData;
  }
}

export function createTrivia(): Trivia {
  return new Trivia();
}
