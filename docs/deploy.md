---
title: Deploy the runtime image standalone
permalink: /how-to/deploy
diataxis: how-to
---

# Deploy Jaiph as a standalone runtime image

The published runtime image — `ghcr.io/jaiphlang/jaiph-runtime` (built from `runtime/Dockerfile`) — already contains `jaiph`, the `claude` / `cursor` / `codex` agent backends, and a full engineering toolchain. This guide runs that image **as the runner itself**: `docker run` on any Linux box, in CI, or as a Kubernetes pod. You supply credentials and `.jh` files; the container does the rest. No host `jaiph` process and no host Docker daemon are involved.

For the host-orchestrated Docker *sandbox* — where a host `jaiph run` clones your workspace and launches this same image as a disposable rootfs — see [Run in a Docker sandbox](sandbox-run.md) and [Sandboxing](sandboxing.md) instead. This page is the opposite direction: the image *is* the deployment.

## Security posture: there is no jaiph-managed sandbox

Read this before deploying. In standalone mode **Jaiph does not create a sandbox**. Isolation is whatever your deployment already provides — the container or pod boundary — and nothing more:

- The image bakes `ENV JAIPH_UNSAFE=true`, so `jaiph run` executes **on the host** (which, here, is the container). This is correct and deliberate: inside the container the container *is* the sandbox, and jaiph must not try to launch a nested Docker daemon (there is none). It also means the [snapshot / gitignore filtering](sandboxing.md#snapshot-content) that the host-orchestrated Docker sandbox performs does **not** happen. Every file you mount is visible to scripts and agent backends verbatim — gitignored secrets included.
- **Workspace content policy is the operator's responsibility.** Unlike the host-orchestrated snapshot sandbox (which never even copies a gitignored `.env` into the container), a standalone container reads exactly what you mount. Do not mount secrets you would not hand to the agent, and treat everything under the mounted workspace as disclosed to the run.
- Container/pod hardening (read-only root FS, dropped capabilities, network policy, non-root UID, resource limits) is yours to configure at the deployment layer. Jaiph adds none of it in standalone mode.

Contrast: under the host-orchestrated sandbox ([Sandboxing](sandboxing.md)) Jaiph drops caps, filters the workspace to a git-defined snapshot, and enforces an env allowlist. Standalone mode has none of those — the boundary is the container runtime you chose.

## One-shot: `docker run`

Mount your working directory at `/work`, set it as the working directory, and spell the full command (the image sets **no `ENTRYPOINT`**, so `jaiph run …` is the container command verbatim):

```bash
# claude backend (Anthropic)
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD":/work -w /work \
  ghcr.io/jaiphlang/jaiph-runtime jaiph run flow.jh
```

The credential env var depends on the backend the entry file selects:

```bash
# cursor backend
docker run --rm -e CURSOR_API_KEY -v "$PWD":/work -w /work \
  ghcr.io/jaiphlang/jaiph-runtime jaiph run flow.jh

# codex backend (OpenAI HTTP API)
docker run --rm -e OPENAI_API_KEY -v "$PWD":/work -w /work \
  ghcr.io/jaiphlang/jaiph-runtime jaiph run flow.jh
```

`-e ANTHROPIC_API_KEY` (no `=value`) forwards the value from your shell environment. A workflow with no `prompt` step needs no credential at all. Run artifacts land under `/work/.jaiph/runs/` — which, because `/work` is your bind-mounted directory, persist on the host after the container exits.

Pin the tag (or a `@sha256:` digest) for reproducibility: `ghcr.io/jaiphlang/jaiph-runtime:<version>`.

## In CI

The image is not required in CI. Jaiph already runs headless on a standard Linux runner without it — `.github/workflows/nightly-engineer.yml` installs jaiph via `docs/install-from-local.sh` (which also builds `runtime/Dockerfile` and registers it as the sandbox image), installs the agent CLI, and runs a workflow unattended in the normal [Docker sandbox](sandboxing.md). A GitHub-hosted Linux runner is itself a VM with a Docker daemon, so that path keeps the host-orchestrated sandbox and needs no published image.

Reach for this image when you want the whole toolchain and all three backends preinstalled with nothing to build. Because the container has no nested Docker daemon and the image bakes `JAIPH_UNSAFE=true`, it runs host-mode (the container is the sandbox), and the `docker run` one-shot above drops straight into any CI step:

```yaml
- name: Run workflow
  run: |
    docker run --rm -e ANTHROPIC_API_KEY -v "$PWD":/work -w /work \
      ghcr.io/jaiphlang/jaiph-runtime:<version> jaiph run flow.jh
```

## Kubernetes

A complete, apply-ready manifest lives at [`docs/deploy/k8s.yaml`](https://github.com/jaiphlang/jaiph/blob/main/docs/deploy/k8s.yaml). It defines a **Deployment** and a **Service** — credentials are deliberately **not** in the file. Create the `jaiph-credentials` Secret out-of-band first:

```bash
kubectl create secret generic jaiph-credentials \
  --from-literal=JAIPH_SERVE_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..."   # only the backend key(s) your workflows use
kubectl apply -f docs/deploy/k8s.yaml
```

The Deployment references the Secret as a **required** `envFrom` — a missing Secret holds the pod in `CreateContainerConfigError` rather than ever starting an unauthenticated runner. `kubectl apply --dry-run=client -f docs/deploy/k8s.yaml` remains a fast schema check, but the real deployment contract is exercised end-to-end on a [kind](https://kind.sigs.k8s.io/) cluster by `e2e/tests/150_k8s_deploy.sh` (run in CI): it applies the manifest, verifies the Secret gate and the hardening below, invokes the health workflow over HTTP with bearer auth, and reads the run's journal back from the runs volume.

The manifest runs `jaiph serve --host 0.0.0.0` as a long-lived HTTP runner (see [Serve workflows over HTTP](serve.md)) with `JAIPH_SERVE_TOKEN` sourced from the Secret, and liveness/readiness probes on `GET /healthz` (which stays open — no bearer token required). The same Service port serves **both** the REST/OpenAPI API and **MCP Streamable HTTP** at `POST /mcp`, so a network MCP client reaches the pod's workflows through the same ingress and bearer token — no extra port or process. Highlights, all reflected in the file:

- **Pod hardening by default.** `runAsNonRoot` with the image's fixed `jaiph` UID/GID (`10001`), `allowPrivilegeEscalation: false`, all capabilities dropped, the `RuntimeDefault` seccomp profile, `readOnlyRootFilesystem: true`, and `automountServiceAccountToken: false` (workflows never talk to the Kubernetes API, so they get no API credential to leak).
- **Writable mounts only where required.** Workflow sources stay read-only (a ConfigMap at `/work`); run artifacts go to a dedicated `emptyDir` at `/jaiph/runs` via `JAIPH_RUNS_DIR` (swap it for a PVC if runs must survive pod replacement). Two more `emptyDir`s cover what Jaiph and the agent CLIs genuinely write: `/tmp` (extracted scripts, scratch) and a fresh `$HOME` at `/jaiph/home` (claude/cursor state; the baked `PATH` still finds `cursor-agent` under the image's read-only `/home/jaiph/.local/bin`).
- **Single replica by design.** The manifest pins `replicas: 1` with a `Recreate` strategy. `jaiph serve` holds its run registry, concurrency cap, and idempotency index in process with no shared store, so multi-replica operation is unsupported — scale vertically (resources + `JAIPH_SERVE_MAX_CONCURRENT`), not by adding replicas. It is restart-safe within that single process: run records persist beside their journals on the runs volume and are reconstructed on startup (use a PVC, not an `emptyDir`, if they must survive pod replacement). See [Serve — deployment topology](serve.md#deployment-topology).
- **Image tag pinning.** The manifest ships `:nightly` with an inline note to pin a released tag or a `@sha256:` digest for production — never track a moving tag.
- **TLS via ingress.** `jaiph serve` speaks plain HTTP; the Service stays `ClusterIP` and you terminate TLS at an Ingress / gateway (cert-manager, a cloud LB, or a mesh) in front of it. Do not expose the token-guarded API to the internet without TLS.
- **Resource requests.** Agent workloads are CPU- and memory-hungry — they spawn backend CLIs plus build/test toolchains. The manifest requests `1` CPU / `2Gi` and limits `2` CPU / `4Gi` as a starting point; tune to your workflows.
- **Auth.** Binding `0.0.0.0` with no authentication is a startup error by design, so the Secret is mandatory. `JAIPH_SERVE_TOKEN` is the single-operator shared secret shown here; for multiple company users configure OIDC/JWT instead (`JAIPH_SERVE_OIDC_ISSUER` + `JAIPH_SERVE_OIDC_AUDIENCE`, with per-user identity and `jaiph:invoke` / `jaiph:inspect` / `jaiph:cancel` scope authorization) — put those non-secret addresses in the manifest `env`. Every `/v1/*` and `POST /mcp` request then requires `Authorization: Bearer <token>`. See [Authenticate and authorize](serve.md#7-authenticate-and-authorize).
- **Observability wiring, credential-free.** Commented `env` entries show where `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` / `SENTRY_ENVIRONMENT` go; anything secret (`SENTRY_DSN`, an `OTEL_EXPORTER_OTLP_HEADERS` auth token) belongs in the `jaiph-credentials` Secret, never in the manifest. See [Observability](observability.md).

The same security posture applies: the pod runs in host mode (`JAIPH_UNSAFE=true` is baked), so **isolation is the pod boundary** — the manifest configures that boundary, and there is no jaiph-managed sandbox inside.

## Related

- [Sandboxing](sandboxing.md) — the host-orchestrated Docker sandbox model this mode deliberately opts out of.
- [Serve workflows over HTTP](serve.md) — the `jaiph serve` API the Kubernetes manifest exposes.
- [Run in a Docker sandbox](sandbox-run.md) — the other direction: a host `jaiph` orchestrating this image as a disposable sandbox.
- [Environment variables](env-vars.md) — `JAIPH_UNSAFE`, `JAIPH_SERVE_TOKEN`, and the rest.
