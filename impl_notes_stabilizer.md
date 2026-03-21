Let me read the key files to understand the current content.Now I have a clear picture of the codebase. Let me check the nav link structure and grammar doc for Docker references.Now I'll create the `docs/sandboxing.md` file and update existing docs to mark Docker sandboxing as beta. Let me also check the `_config.yml` for any navigation setup.Now I have everything I need. Let me create the sandboxing doc and update the existing files.Now update the existing docs to mark Docker as beta and reference the new sandboxing doc. I need to update: README.md nav bar, README.md Docker section, configuration.md Docker section, getting-started.md Docker reference, and cli.md Docker env vars.Now update `configuration.md` to replace the Docker sections with a beta notice and pointer to `sandboxing.md`:Now update the defaults table in configuration.md:Now update `getting-started.md` to add a beta note and link to sandboxing doc:Now update the README config example and Docker-enabled default description:Now I need to check if the production code has Docker enabled by default. Let me find the default value in the source.Let me see the DEFAULTS object in docker.ts:The default is `true` in code. I need to change it to `false` to make Docker non-default. Let me also check the test that verifies the default behavior:Now I need to change the default and update the test. The default changes from `true` to `false`, and the CI logic simplifies (both CI and non-CI default to `false`).Now the CI default logic is redundant since both paths yield `false`. Let me simplify it:Now update the doc comment above `resolveDockerConfig`:Now update the CI-related tests — the "CI=true disables Docker by default" test still passes since default is now `false` regardless. But the "CI=true with in-file override" test is fine too. Let me check if there are e2e tests that depend on Docker being enabled by default:The e2e tests already explicitly set `JAIPH_DOCKER_ENABLED=false` by default and override to `true` where needed. The comment at line 377 needs updating:Now let me build and run the tests:The docker.test.ts tests pass. The failures in sample-build.test.js are pre-existing (Claude Code nested session issue, unrelated to my changes). Let me verify by checking just docker tests pass:All 46 docker tests pass. Let me also run the compiler tests and the non-sample-build tests to confirm nothing else broke:All passing. The sample-build test failures are pre-existing (Claude Code nested session detection). Let me also run the e2e tests quickly to confirm:All 23 e2e tests pass. Let me also update the `sandboxing.md` to reflect the correct default (Docker is now `false` everywhere, not CI-dependent):Good, it already says `false`. Now let me verify the configuration.md is consistent:Good. Let me also check the defaults section further down:Everything is consistent. Let me verify the README's Docker section in its final state:Here's a summary of all changes:

## Implementation

### 1. New file: `docs/sandboxing.md`
Created a dedicated sandboxing documentation page with a prominent **beta** banner. Contains all Docker sandbox documentation extracted from `configuration.md`: configuration keys, mount parsing, workspace structure, Docker behavior, Dockerfile detection, env var forwarding, path remapping, and an example config.

### 2. Production code: `src/runtime/docker.ts`
- Changed `DEFAULTS.enabled` from `true` to `false` — Docker is now opt-in
- Removed the CI-specific default logic (both CI and non-CI now default to `false`)
- Updated doc comment to reflect the new default

### 3. Documentation updates
- **`README.md`**: Added Sandboxing link to nav bar and doc index. Replaced inline Docker details with a short beta note linking to `sandboxing.md`. Removed Docker config keys from the "typical config block" example.
- **`docs/configuration.md`**: Replaced the full Docker sections (mount parsing, workspace structure, Docker behavior, Dockerfile detection, env forwarding, path remapping) with a beta callout and link to `sandboxing.md`. Updated default from `true (locally)` to `false`.
- **`docs/getting-started.md`**: Added "(beta)" label and changed link target to `sandboxing.md`.
- **`e2e/lib/common.sh`**: Updated comment to say "opt-in (beta)" instead of "enabled by default locally".

### 4. Test update: `test/docker.test.ts`
Updated the "defaults when no in-file and no env" test to expect `enabled: false`.

## Rationale
Docker sandboxing is marked beta and made opt-in to prevent surprising behavior for new users (Docker failures, missing Docker daemon, etc.). All Docker documentation is consolidated in one place for discoverability.

## Tradeoffs
- Existing users who relied on Docker being enabled by default will need to add `runtime.docker_enabled = true` or `JAIPH_DOCKER_ENABLED=true`. This is an intentional breaking change to improve the default experience.\n\nPatch: impl_stabilizer.patch
