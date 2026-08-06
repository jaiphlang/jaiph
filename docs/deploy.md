---
title: Deploy the runtime image standalone
permalink: /how-to/deploy
diataxis: how-to
---

# Deploy Jaiph as a standalone runtime image

The published runtime image `ghcr.io/jaiphlang/jaiph-runtime` (built from `runtime/Dockerfile`) already contains `jaiph`, the `claude`, `cursor`, and `codex` agent backends, and a full engineering toolchain. This guide runs that image as the runner itself, with `docker run` on any Linux machine, in CI, or as a Kubernetes pod. You supply credentials and `.jh` files, and the container does the rest. There is no host `jaiph` process and no host Docker daemon involved.

There is a different mode called the host-orchestrated Docker sandbox, where a host `jaiph run` clones your workspace and launches this same image as a disposable root filesystem. For that mode, see [Run in a Docker sandbox](sandbox-run.md) and [Sandboxing](sandboxing.md) instead. This guide covers the opposite direction, where the image itself is the deployment.

## Standalone mode has no jaiph-managed sandbox

Read this before you deploy. In standalone mode Jaiph does not create a sandbox. Isolation is whatever your deployment already provides, which is the container or pod boundary and nothing more:

- Jaiph runs on the host on purpose. The image bakes `ENV JAIPH_UNSAFE=true`, so `jaiph run` / `jaiph serve` / `jaiph mcp` execute on the host, which here is the container. Inside the container the container is the sandbox, and jaiph must not try to launch a nested Docker daemon when there is none. A factory VPS or Kubernetes pod that runs this image does **not** need `--unsafe` on the command line: server startup detects the container (or `KUBERNETES_SERVICE_HOST`) and treats the baked `JAIPH_UNSAFE=true` as the documented standalone posture, so `E_UNSAFE_NO_CONSENT` does not apply. That refusal exists only for a bare-metal host where an ambient `JAIPH_UNSAFE=true` (for example left in a shell profile) would otherwise silently unsandbox `jaiph serve` / `jaiph mcp` — on bare metal pass `--unsafe` (or `--yes`) on the unit's `ExecStart` if you truly want host-only. It also means the [snapshot and gitignore filtering](sandboxing.md#snapshot-content) that the host-orchestrated Docker sandbox performs does not happen. Every file you mount is visible to scripts and agent backends exactly as it is, including gitignored secrets.
- **Workspace content is your responsibility.** Unlike the host-orchestrated snapshot sandbox, which never copies a gitignored `.env` into the container, a standalone container reads exactly what you mount. Do not mount secrets you would not hand to the agent, and treat everything under the mounted workspace as visible to the run.
- **Hardening is yours to configure.** Container and pod hardening (read-only root filesystem, dropped capabilities, network policy, non-root UID, resource limits) is yours to set at the deployment layer. Jaiph adds none of it in standalone mode.

Under the host-orchestrated sandbox ([Sandboxing](sandboxing.md)) Jaiph drops capabilities, filters the workspace to a git-defined snapshot, and enforces an environment allowlist. Standalone mode has none of those steps, and the only boundary is the container runtime you chose.

## Run one workflow with `docker run`

Mount your working directory at `/work`, set it as the working directory, and write out the full command. The image sets no `ENTRYPOINT`, so `jaiph run …` is the container command exactly as you type it:

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

`-e ANTHROPIC_API_KEY` with no `=value` forwards the value from your shell environment. The `claude` backend also accepts `CLAUDE_CODE_OAUTH_TOKEN` in place of `ANTHROPIC_API_KEY`. A workflow with no `prompt` step needs no credential at all. Run artifacts land under `/work/.jaiph/runs/`, and because `/work` is your bind-mounted directory, they persist on the host after the container exits.

Pin the tag or a `@sha256:` digest for reproducible runs, for example `ghcr.io/jaiphlang/jaiph-runtime:<version>`.

## In CI

The image is not required in CI. Jaiph already runs headless on a standard Linux runner without it. For example, `.github/workflows/nightly-engineer.yml` installs jaiph via `docs/install-from-local.sh` (which also builds `runtime/Dockerfile` and registers it as the sandbox image), installs the agent CLI, and runs a workflow unattended in the normal [Docker sandbox](sandboxing.md). A GitHub-hosted Linux runner is itself a virtual machine with a Docker daemon, so that path keeps the host-orchestrated sandbox and needs no published image.

Use this image when you want the whole toolchain and all three backends preinstalled with nothing to build. Because the container has no nested Docker daemon and the image bakes `JAIPH_UNSAFE=true`, it runs in host mode where the container is the sandbox, and the `docker run` one-shot above fits into any CI step:

```yaml
- name: Run workflow
  run: |
    docker run --rm -e ANTHROPIC_API_KEY -v "$PWD":/work -w /work \
      ghcr.io/jaiphlang/jaiph-runtime:<version> jaiph run flow.jh
```

## Kubernetes

A complete, apply-ready manifest lives at [`docs/deploy/k8s.yaml`](https://github.com/jaiphlang/jaiph/blob/main/docs/deploy/k8s.yaml). It defines a Deployment and a Service, and it deliberately leaves credentials out of the file. Create the `jaiph-credentials` Secret out-of-band first:

```bash
kubectl create secret generic jaiph-credentials \
  --from-literal=JAIPH_SERVE_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..."   # only the backend key(s) your workflows use
kubectl apply -f docs/deploy/k8s.yaml
```

The Deployment references the Secret as a required `envFrom`, so a missing Secret holds the pod in `CreateContainerConfigError` instead of ever starting an unauthenticated runner. `kubectl apply --dry-run=client -f docs/deploy/k8s.yaml` is a fast schema check. The real deployment contract is tested end-to-end on a [kind](https://kind.sigs.k8s.io/) cluster by `e2e/tests/150_k8s_deploy.sh`, which runs in CI. It applies the manifest, verifies the Secret gate and the hardening described below, invokes the health workflow over HTTP with bearer auth, and reads the run's journal back from the runs volume.

The manifest runs `jaiph serve --host 0.0.0.0` as a long-lived HTTP runner (see [Serve workflows over HTTP](serve.md)), with `JAIPH_SERVE_TOKEN` sourced from the Secret and liveness and readiness probes on `GET /healthz`, which stays open and needs no bearer token. The same Service port serves both the REST and OpenAPI API and MCP Streamable HTTP at `POST /mcp`, so a network MCP client reaches the pod's workflows through the same ingress and bearer token, with no extra port or process. The manifest sets the following, and every item is reflected in the file:

- **Pod hardening by default.** The pod runs with `runAsNonRoot` and the image's fixed `jaiph` UID and GID (`10001`), `allowPrivilegeEscalation: false`, all capabilities dropped, the `RuntimeDefault` seccomp profile, `readOnlyRootFilesystem: true`, and `automountServiceAccountToken: false`. Workflows never talk to the Kubernetes API, so they get no API credential to leak.
- **Writable mounts only where required.** Workflow sources stay read-only as a ConfigMap at `/work`. Run artifacts go to a dedicated `emptyDir` at `/jaiph/runs` set by `JAIPH_RUNS_DIR`, and you can swap it for a PersistentVolumeClaim if runs must survive pod replacement. Two more `emptyDir` volumes cover what Jaiph and the agent CLIs write. One is `/tmp` for extracted scripts and scratch space, and the other is a fresh `$HOME` at `/jaiph/home` for claude and cursor state. The baked `PATH` still finds `cursor-agent` under the image's read-only `/home/jaiph/.local/bin`.
- **Single replica by design.** The manifest pins `replicas: 1` with a `Recreate` strategy. `jaiph serve` holds its run registry, concurrency cap, and idempotency index in process with no shared store, so running more than one replica is not supported. Scale vertically with more resources and `JAIPH_SERVE_MAX_CONCURRENT`, not by adding replicas. A single process is restart-safe, because run records persist beside their journals on the runs volume and are reconstructed on startup. Use a PersistentVolumeClaim, not an `emptyDir`, if the records must survive pod replacement. See [Serve, deployment topology](serve.md#deployment-topology).
- **Image tag pinning.** The manifest ships `:nightly` with an inline note to pin a released tag or a `@sha256:` digest for production. Never track a moving tag.
- **TLS at the ingress.** `jaiph serve` speaks plain HTTP. The Service stays `ClusterIP`, and you terminate TLS at an Ingress or gateway in front of it, such as cert-manager, a cloud load balancer, or a service mesh. Do not expose the token-guarded API to the internet without TLS.
- **Resource requests.** Agent workloads use a lot of CPU and memory, because they spawn backend CLIs plus build and test toolchains. The manifest requests `1` CPU and `2Gi` and limits `2` CPU and `4Gi` as a starting point, and you should tune these to your workflows.
- **Authentication.** Binding `0.0.0.0` with no authentication is a startup error by design, so the Secret is mandatory. `JAIPH_SERVE_TOKEN` is the single-operator shared secret shown here. For multiple company users, configure OIDC or JWT instead with `JAIPH_SERVE_OIDC_ISSUER` and `JAIPH_SERVE_OIDC_AUDIENCE`, which give each user their own identity and authorize the `jaiph:invoke`, `jaiph:inspect`, and `jaiph:cancel` scopes. Put those non-secret addresses in the manifest `env`. Every `/v1/*` and `POST /mcp` request then requires an `Authorization: Bearer <token>` header. See [Authenticate and authorize](serve.md#7-authenticate-and-authorize).
- **Observability wiring without credentials.** Commented `env` entries show where `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, and `SENTRY_ENVIRONMENT` go. Anything secret, such as `SENTRY_DSN` or an `OTEL_EXPORTER_OTLP_HEADERS` auth token, belongs in the `jaiph-credentials` Secret, never in the manifest. See [Observability](observability.md).

The same security posture applies. The pod runs in host mode because `JAIPH_UNSAFE=true` is baked, so isolation is the pod boundary. The manifest configures that boundary, and there is no jaiph-managed sandbox inside.

## Related

- [Sandboxing](sandboxing.md), the host-orchestrated Docker sandbox model that standalone mode deliberately opts out of.
- [Serve workflows over HTTP](serve.md), the `jaiph serve` API that the Kubernetes manifest exposes.
- [Run in a Docker sandbox](sandbox-run.md), the other direction, where a host `jaiph` orchestrates this image as a disposable sandbox.
- [Environment variables](env-vars.md), covering `JAIPH_UNSAFE`, `JAIPH_SERVE_TOKEN`, and the rest.
