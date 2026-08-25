---
title: Deploy jaiph
permalink: /how-to/deploy
diataxis: how-to
---

# Deploy jaiph in your own image or pod

Jaiph executes workflows on the host. It does not ship a runtime image or a Docker sandbox driver. Isolation is an outer concern: wrap `jaiph` in a container, a Kubernetes pod, a CI runner, or another sandbox you already operate.

A complete, apply-ready Kubernetes example lives at [`docs/deploy/k8s.yaml`](https://github.com/jaiphlang/jaiph/blob/main/docs/deploy/k8s.yaml). It assumes **your** image already has `jaiph` on `PATH`. Build that image yourself (install the CLI, any agent backends your workflows use, and whatever toolchain the scripts need). Jaiph does not publish a first-party runner image.

## Isolation is yours

`jaiph run`, `jaiph serve`, and `jaiph mcp` execute as ordinary host processes. They do not drop capabilities, clone a workspace snapshot, or filter the environment into a sandbox allowlist.

- **Workspace content is your responsibility.** Everything you mount or copy into the process working directory is visible to scripts and agent backends, including gitignored secrets. Do not mount files you would not hand to the agent.
- **Hardening is yours to configure.** Container and pod settings (read-only root filesystem, dropped capabilities, network policy, non-root UID, resource limits) belong at the deployment layer.

## Run one workflow in a container you own

Mount your working directory and run the CLI as the container command. Replace `your-registry/your-jaiph-image` with an image you built:

```bash
# claude backend (Anthropic)
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD":/work -w /work \
  your-registry/your-jaiph-image jaiph run flow.jh
```

The credential env var depends on the backend the entry file selects:

```bash
# cursor backend
docker run --rm -e CURSOR_API_KEY -v "$PWD":/work -w /work \
  your-registry/your-jaiph-image jaiph run flow.jh

# codex backend (OpenAI HTTP API)
docker run --rm -e OPENAI_API_KEY -v "$PWD":/work -w /work \
  your-registry/your-jaiph-image jaiph run flow.jh
```

`-e ANTHROPIC_API_KEY` with no `=value` forwards the value from your shell environment. The `claude` backend also accepts `CLAUDE_CODE_OAUTH_TOKEN` in place of `ANTHROPIC_API_KEY`. A workflow with no `prompt` step needs no credential at all. Run artifacts land under `/work/.jaiph/runs/` when `/work` is your bind-mounted directory.

## In CI

Jaiph already runs headless on a standard Linux runner. Install the CLI (`docs/install` or `docs/install-from-local.sh`), install any agent CLI your workflows need, and run `jaiph run flow.jh`. A GitHub-hosted Linux runner is itself a virtual machine; that outer boundary is the sandbox.

Use a container image when you want a preinstalled toolchain. Fit the one-shot `docker run` above into any CI step:

```yaml
- name: Run workflow
  run: |
    docker run --rm -e ANTHROPIC_API_KEY -v "$PWD":/work -w /work \
      your-registry/your-jaiph-image jaiph run flow.jh
```

## Kubernetes

Create the `jaiph-credentials` Secret out-of-band first, then apply the example manifest. Edit the Deployment `image:` to your image before apply:

```bash
kubectl create secret generic jaiph-credentials \
  --from-literal=JAIPH_SERVE_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..."   # only the backend key(s) your workflows use
kubectl apply -f docs/deploy/k8s.yaml
```

The Deployment references the Secret as a required `envFrom`, so a missing Secret holds the pod in `CreateContainerConfigError` instead of ever starting an unauthenticated runner.

The manifest runs `jaiph serve --host 0.0.0.0` as a long-lived HTTP runner (see [Serve workflows over HTTP](serve.md)), with `JAIPH_SERVE_TOKEN` sourced from the Secret and liveness and readiness probes on `GET /healthz`, which stays open and needs no bearer token. The same Service port serves both the REST and OpenAPI API and MCP Streamable HTTP at `POST /mcp`. The example sets:

- **Pod hardening by default.** `runAsNonRoot`, `allowPrivilegeEscalation: false`, all capabilities dropped, the `RuntimeDefault` seccomp profile, `readOnlyRootFilesystem: true`, and `automountServiceAccountToken: false`. Workflows never talk to the Kubernetes API, so they get no API credential to leak. Set `runAsUser` / `runAsGroup` to match the user in **your** image.
- **Writable mounts only where required.** Workflow sources stay read-only as a ConfigMap at `/work`. Run artifacts go to a dedicated `emptyDir` at `/jaiph/runs` set by `JAIPH_RUNS_DIR`. Two more `emptyDir` volumes cover `/tmp` and a writable `$HOME`.
- **Single replica by design.** The manifest pins `replicas: 1` with a `Recreate` strategy. `jaiph serve` holds its run registry, concurrency cap, and idempotency index in process with no shared store, so running more than one replica is not supported. Scale vertically with more resources and `JAIPH_SERVE_MAX_CONCURRENT`, not by adding replicas. See [Serve, deployment topology](serve.md#deployment-topology).
- **TLS at the ingress.** `jaiph serve` speaks plain HTTP. The Service stays `ClusterIP`, and you terminate TLS at an Ingress or gateway in front of it. Do not expose the token-guarded API to the internet without TLS.
- **Authentication.** Binding `0.0.0.0` with no authentication is a startup error by design, so the Secret is mandatory. `JAIPH_SERVE_TOKEN` is the single-operator shared secret shown here. For multiple company users, configure OIDC or JWT instead. See [Authenticate and authorize](serve.md#7-authenticate-and-authorize).

Isolation is the pod boundary. There is no jaiph-managed sandbox inside.

## Related

- [Serve workflows over HTTP](serve.md), the `jaiph serve` API that the Kubernetes manifest exposes.
- [Environment variables](env-vars.md), covering `JAIPH_SERVE_TOKEN` and the rest.
