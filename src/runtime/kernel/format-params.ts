/**
 * Build key/value pairs for run trees. Uses declared workflow/rule param names when arity matches;
 * otherwise positional keys: `1`, `2`, … for the root banner, `arg1`, `arg2`, … for managed steps.
 *
 * Lives in the runtime (layer 3) because the kernel emits these pairs on every
 * managed step; the CLI (layer 4) reuses it through the runtime public entry
 * (`src/runtime/index.ts`) rather than the runtime reaching up into CLI.
 */
export function buildStepDisplayParamPairs(
  args: string[],
  declaredNames?: string[],
  options?: { positionalStyle: "numeric" | "argN" },
): Array<[string, string]> {
  if (declaredNames && declaredNames.length > 0 && declaredNames.length === args.length) {
    return args.map((v, i) => [declaredNames[i]!, v]);
  }
  const style = options?.positionalStyle ?? "argN";
  if (style === "numeric") {
    return args.map((v, i) => [String(i + 1), v]);
  }
  return args.map((v, i) => [`arg${i + 1}`, v]);
}
