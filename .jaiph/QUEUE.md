# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Harden inbox <!-- dev-ready -->

Add e2e coverage for the inbox/dispatch system and a homepage sample demonstrating it.

### E2E tests

Currently only unit/golden tests exist (`test/compiler-golden.test.ts` with `test/fixtures/inbox.jh`). Add a new shell-based e2e test (`e2e/tests/91_inbox_dispatch.sh`) following the project's existing pattern (`e2e::prepare_test_env`, heredoc `.jh` files, `e2e::assert_*` helpers). Cover at minimum:

1. **Basic send + route**: A workflow sends a message on a channel; a routed workflow receives it as `$1` and echoes it. Assert the echoed output.
2. **Multi-target route**: `on channel -> wf1, wf2` dispatches to both targets sequentially. Assert both produce output.
3. **Silent drop on unregistered channel**: A send to a channel with no route does not error. Assert exit code 0.
4. **Inbox file written**: After a send, `.jaiph/runs/.../inbox/001-<channel>.txt` exists with the message content.

### Homepage sample

Add an "inbox" tab to `docs/index.html` alongside the existing three sample tabs. Use a short, self-contained example (e.g., a two-workflow pipeline: one sends findings, one receives and summarizes). Keep it under ~15 lines of Jaiph code. Follow the existing tab markup pattern (`.code-tab-button[data-target]` + `.code-panel[data-panel]`).

### Acceptance criteria

1. `e2e/tests/91_inbox_dispatch.sh` passes as part of `npm run test:e2e`.
2. All four scenarios above are covered with assertions.
3. `docs/index.html` has a fourth sample tab showing an inbox workflow.
4. Existing e2e and unit tests still pass.
