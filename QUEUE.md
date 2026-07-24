# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Feat: standalone runtime image — run jaiph in docker/k8s without a host orchestrator #dev-ready

**Source:** Deployability feedback (2026-07-23): "a docker image with codex/cursor/claude code already installed so that the user only needs to put the credentials + the jaiph files and run it … that would allow anyone to run jaiph in docker/kubernetes" — and "it can't depend on a local machine + docker".

**Problem:** `ghcr.io/jaiphlang/jaiph-runtime` (`runtime/Dockerfile`) already contains jaiph plus the claude/cursor/codex backends and a full toolchain, but it is only ever used as a sandbox rootfs *orchestrated by a host jaiph process*. Running it directly (`docker run … jaiph run flow.jh`, or as a k8s pod) fails the wrong way: jaiph defaults to Docker sandboxing on Linux and there is no Docker daemon inside the container. There is also zero documentation for deploying the image as the runner itself, even though `.github/workflows/nightly-engineer.yml` proves jaiph works headless on a bare Linux box.

**Required behavior:**

* **Bake `ENV JAIPH_UNSAFE=true` into `runtime/Dockerfile`** with a comment stating the rationale: *inside this image, the container is the sandbox* — host-mode execution is the correct default, and the interactive `--unsafe` confirmation is impossible/meaningless in an unattended pod. Verify and pin by test that this does not change host-orchestrated sandbox behavior: the container-inner invocation is `jaiph run --raw`, which by contract never launches Docker regardless of `JAIPH_UNSAFE` (the existing Docker e2e suite must stay green with the ENV present).
* Do **not** add an `ENTRYPOINT` and do not change `WORKDIR`: the host-orchestrated sandbox passes an explicit command argv, and an entrypoint prefix would corrupt it. Standalone usage spells the full command (`docker run … ghcr.io/jaiphlang/jaiph-runtime jaiph run /work/flow.jh`).
* When jaiph would launch Docker but the CLI is unavailable **and** a container indicator is present (`/.dockerenv` or `/run/.containerenv`), the error message must say precisely what to do: running inside a container already — set `JAIPH_UNSAFE=true` (host mode; the container is the sandbox). This covers users of derived images without the baked ENV.
* New `docs/deploy.md` (how-to, linked from README, `docs/sandboxing.md`, and `docs/setup.md`):
  * one-shot: `docker run --rm -e ANTHROPIC_API_KEY -v "$PWD":/work -w /work ghcr.io/jaiphlang/jaiph-runtime jaiph run flow.jh` (and the cursor/codex credential variants — `CURSOR_API_KEY`, `OPENAI_API_KEY`);
  * CI usage note pointing at the pattern `nightly-engineer.yml` already uses;
  * Kubernetes: a real manifest file `docs/deploy/k8s.yaml` (Deployment + Secret for backend credentials + Service; liveness/readiness probes; image tag pinning note; TLS-via-ingress note; resource-request guidance — agent workloads are CPU/memory hungry). If `jaiph serve` exists in the codebase when this task is implemented, the manifest runs `jaiph serve --host 0.0.0.0` with `JAIPH_SERVE_TOKEN` from the Secret and probes `/healthz`; otherwise the manifest demonstrates a long-lived workflow runner and the doc says the HTTP surface is queued.
  * A plainly-stated security paragraph: in standalone mode there is **no** jaiph-managed sandbox — isolation is whatever the deployment provides (the container/pod boundary), and workspace content policy (gitignored secrets etc.) is the operator's responsibility, unlike the host-orchestrated snapshot sandbox.
* CI smoke test (job in `.github/workflows/ci.yml` on the built image, or a gated e2e in `e2e/tests/` where the image is available): run the image standalone with `docker run` executing a fixture workflow that writes a `return` value; assert the value round-trips and exit code 0 — proving the "put credentials + jaiph files and run it" story on every build.
* Manifest validity gate: `kubectl apply --dry-run=client -f docs/deploy/k8s.yaml` (kubectl is on GitHub runners) runs in CI and passes.
* No new `JAIPH_*` env vars expected; any introduced must get `docs/env-vars.md` rows (parity lint). Update the `JAIPH_UNSAFE` row to mention the image bakes it.

Acceptance:

* CI (or gated e2e) smoke test: `docker run --rm -v <fixture>:/work -w /work <image> jaiph run hello.jh` exits 0 and produces the expected return value, with no Docker daemon available inside the container.
* The full existing Docker-sandbox e2e suite passes against the image with the baked `ENV JAIPH_UNSAFE=true` (host-orchestrated behavior unchanged).
* Unit test for the container-detection error path: docker unavailable + `/.dockerenv` present (injectable check) yields the "container is the sandbox → set JAIPH_UNSAFE=true" message; without the indicator, the existing error is unchanged.
* `kubectl apply --dry-run=client -f docs/deploy/k8s.yaml` passes in CI.
* `docs/deploy.md` exists, is linked from README + `docs/sandboxing.md` + `docs/setup.md`, and documents the no-jaiph-sandbox security posture explicitly.
* `npm test` and `npm run test:e2e` pass.

***
