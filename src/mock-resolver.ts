/**
 * Legacy TOML mock resolver — no longer used by `jaiph test`.
 * Test mocks are declared inline in *.test.jh via `mock prompt "..."` or
 * `mock prompt { if $1 contains "..." ; then respond "..." ; fi }`.
 */

export interface MockDef {
  prompt_contains: string;
  response: string;
}

/**
 * @deprecated TOML mock files are not used. Use inline mock prompt blocks in *.test.jh.
 * @throws Error if called
 */
export function loadMocks(_tomlPath: string): MockDef[] {
  throw new Error(
    "jaiph test no longer uses .test.toml files. Declare mocks inline in *.test.jh with mock prompt \"...\" or mock prompt { if $1 contains \"...\" ; then respond \"...\" ; fi }",
  );
}

/**
 * @deprecated Use inline mocks in test files.
 * @throws Error if called
 */
export function resolveMock(_mocks: MockDef[], _promptText: string): string | null {
  throw new Error("jaiph test no longer uses TOML mocks. Use inline mock prompt blocks in *.test.jh");
}
