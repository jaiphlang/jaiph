# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Possible bug in Docker

When I run e2e/say_hello.jh on local machine, it does not span any docker container.
By default Jaiph should run in docker locally, and with no docker when it is executed in CI (probably detect CI=true)

---

## Restructure .jaiph/runs directory

Currently it's too bloated. I'd like to have a different directory structure. It should be:

.jaiph/runs/2026-03-18/07-03-28-<jaiph-file-name.jh>/

---

## Harden inbox

- Ensure there are e2e tests for messaging/inbox in Jaiph files
- Add a reasonable and short inbox sample to sample tabs in index.html