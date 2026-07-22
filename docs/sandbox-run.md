---
title: Run in a Docker sandbox
permalink: /how-to/sandbox-run
diataxis: how-to
---

# Run a workflow in a Docker sandbox

This recipe runs a `.jh` workflow inside the Docker sandbox, picks the right workspace-presentation mode, and bypasses the confirmation prompt in CI.

For the design (what the sandbox protects against, what it does not), see [Sandboxing](sandboxing.md). This page is the enabling procedure only.

## Prerequisites

- Docker installed and `docker info` succeeds on the host.
- An entry `.jh` file with a `default` workflow.
- Agent credentials forwarded into the container if the workflow uses `prompt` — see [Authenticate agent backends](/how-to/agent-auth).

## 1. Run with the default sandbox

```bash
jaiph run ./flow.jh
```

Docker is **on by default**. The CLI picks the workspace-presentation mode automatically:

- **Overlay mode** when `/dev/fuse` exists on the host (typically Linux). Reads come from the read-only host workspace; writes land in a `fuse-overlayfs` upper layer and are discarded at container exit.
- **Copy mode** when `/dev/fuse` is missing (typically macOS Docker Desktop), or when `JAIPH_DOCKER_NO_OVERLAY=1` or `JAIPH_DOCKER_NO_OVERLAY=true` is set. The CLI clones the workspace into `.jaiph/runs/.sandbox-<id>/` (or `<runs-root>/.sandbox-<id>/` when `JAIPH_RUNS_DIR` overrides the default) and mounts the clone read-write.

In both modes the host checkout is unmodified after the run. Run artifacts always land under host `.jaiph/runs/` via a separate read-write mount.

The two modes differ in capability posture, not in the isolation guarantee. Overlay **elevates during setup**: the container starts as root with `SYS_ADMIN` (plus `SETUID`/`SETGID`/`CHOWN`/`DAC_READ_SEARCH`, and `apparmor=unconfined` on Linux) so it can mount `fuse-overlayfs`, then drops to your UID before the workflow starts. Copy mode never elevates — no added capabilities, no AppArmor exception. Force `JAIPH_DOCKER_NO_OVERLAY=1` on shared hosts, under security policy that forbids `SYS_ADMIN`/unconfined containers, or for untrusted workflows: you pay a per-run workspace copy and get the minimal posture. Details: [Sandboxing — Overlay elevates during setup](sandboxing.md#overlay-capability-posture).

## 2. Pick inplace mode for live edits

When you want the run's edits to land **live on the host** (typical for an agent-driven dev loop), opt in to inplace mode:

```bash
jaiph run --inplace ./flow.jh
```

or set the environment variable (`1` or `true`):

```bash
JAIPH_INPLACE=1 jaiph run ./flow.jh
```

The `--inplace` flag normalizes into `JAIPH_INPLACE=1` for one run only. The container's other protections (`--cap-drop ALL`, `--security-opt no-new-privileges`, env allowlist, mount allowlist) are unchanged — only the workspace-isolation half is removed.

Before launch the CLI prints a warning — the run can edit files directly in your workspace directory, and the rest of your machine stays inside the Docker sandbox — then waits for `y`. The default answer on empty input or EOF is **no**.

## 3. Skip the inplace confirmation prompt in CI

When stdout is not a TTY (typical in CI), the inplace prompt cannot run interactively. Pass `-y` / `--yes` with `--inplace`, or set `JAIPH_INPLACE_YES=1` or `JAIPH_INPLACE_YES=true`:

```bash
jaiph run --inplace --yes ./flow.jh
```

```bash
JAIPH_INPLACE=1 JAIPH_INPLACE_YES=1 jaiph run ./flow.jh
```

Without one of these in a non-TTY environment, the run aborts with `E_DOCKER_INPLACE_NO_CONFIRM` before any container is launched.

## 4. Run on the host without a sandbox

```bash
jaiph run --unsafe ./flow.jh
```

or:

```bash
JAIPH_UNSAFE=true jaiph run ./flow.jh
```

This disables Docker entirely; the workflow runs on the host with full access to your machine. Because that is strictly more exposure than inplace, the CLI prints its own (stronger) warning and waits for `y` before launching — default **no**. Skip it the same way as the inplace prompt: `-y` / `--yes`, or `JAIPH_INPLACE_YES=1` / `JAIPH_INPLACE_YES=true`. In a non-TTY environment without one of these, the run aborts with `E_UNSAFE_NO_CONFIRM`. The prompt fires only when the unsafe opt-in is what turns Docker off — not when Docker is disabled for another reason (the Windows host-only override, or an explicit `JAIPH_DOCKER_ENABLED=false`).

Combining `--unsafe` with `--inplace` is rejected with `E_FLAG_CONFLICT` before any container starts (one keeps the sandbox on, the other turns it off).

## Verification

The CLI banner reports the sandbox mode it picked:

- `Docker sandbox, fusefs` — overlay mode.
- `Docker sandbox, tmp workspace` — copy mode.
- `Docker sandbox, in-place` — inplace mode.
- `Docker sandbox, unsafe` — `--unsafe` / `JAIPH_UNSAFE=true` opted out of the sandbox (Docker off, host-only).
- `no sandbox` — Docker is off for another reason (the Windows host-only override, or an explicit `JAIPH_DOCKER_ENABLED=false`).

Run artifacts always land under host `.jaiph/runs/<date>/<time>-<entry>/` regardless of mode. Open `run_summary.jsonl` there to inspect the live `__JAIPH_EVENT__` timeline the CLI also rendered.

## Related

- [Sandboxing](sandboxing.md) — the model: what each mode protects, what it does not.
- [Sandboxing — Runtime image toolchain](sandboxing.md#runtime-image-toolchain) — preinstalled CLI tools inside the default image.
- [Authenticate agent backends](/how-to/agent-auth) — getting credentials into the container.
- [Architecture — Docker runtime helper](architecture.md#core-components) — how the host CLI builds the `docker run` invocation.
