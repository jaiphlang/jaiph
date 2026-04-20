# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
6. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.
7. **Before starting any task, read `docs/target-design.md` end-to-end**, including the "Implementation pitfalls observed in the prior attempt" section. Several task descriptions below intentionally repeat points from that section; that is not redundancy, it is reinforcement of contracts the previous pass missed.

***

## Cleanup — remove the target design document after the rewrite lands #dev-ready

**Goal**
`docs/target-design.md` is a temporary planning artifact. Once the rewrite is implemented and the real docs are updated, remove it.

**Scope**

* Delete `docs/target-design.md`.
* Ensure the permanent docs fully cover the shipped model before deletion.
* Before deleting, decide explicitly what to do with the "Implementation pitfalls observed in the prior attempt" section: fold the still-relevant points into `CONTRIBUTING.md` / a permanent design page, or drop them as historical. Do not silently lose them by deleting the file.
* Remove stale references to the temporary design page.

**Acceptance criteria**

* `docs/target-design.md` is deleted.
* Permanent docs stand on their own without referring readers to the temporary design document.

***
