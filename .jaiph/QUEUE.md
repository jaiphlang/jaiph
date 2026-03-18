# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Reduce the runtime reporting code - make it the same for both docker and non-docker

---

## Improve e2e tests -- assert full stdout, not only selected lines

---

## Inbox: Pass event channel as first parameter to the workflow, reuse existing parameter print for workflow (don't do anything custom)

---

## Maybe rework the ourput to be handled by bash sdk, and not JS
