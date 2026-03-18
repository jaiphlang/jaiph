# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Bug: log seems not to be emitted when running in docker sandbox <!-- dev-ready -->

```
➜  jaiph git:(nightly) ✗ CI=true e2e/agent_inbox.jh

Jaiph: Running agent_inbox.jh

workflow default

  ▸ workflow scanner
  ✓ 0s
  ▸ workflow analyst (findings, "Found 3 issues in auth module")
  ✓ 0s
  ▸ workflow reviewer (report, "Summary: Found 3 issues in auth ...")
  ✓ 0s
    [reviewed] Summary: Found 3 issues in auth module
✓ PASS workflow default (0.2s)
➜  jaiph git:(nightly) ✗ e2e/agent_inbox.jh

Jaiph: Running agent_inbox.jh

workflow default

  ▸ workflow scanner
  ✓ 0s
  ▸ workflow analyst (findings, "Found 3 issues in auth module")
  ✓ 0s
  ▸ workflow reviewer (report, "Summary: Found 3 issues in auth ...")
  ✓ 0s
✓ PASS workflow default (1.6s)
➜  jaiph git:(nightly) ✗
```

---

## Reduce the runtime reporting code - make it the same for both docker and non-docker

---

## Improve e2e tests -- assert full stdout, not only selected lines

---

## Inbox: Pass event channel as first parameter to the workflow, reuse existing parameter print for workflow (don't do anything custom)

---

## Maybe rework the ourput to be handled by bash sdk, and not JS