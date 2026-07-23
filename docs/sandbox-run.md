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

Docker is **on by default**. In the default **snapshot mode** the CLI takes a **writable point-in-time snapshot** of the workspace at run start — a host-side clone (block-level copy-on-write where the filesystem supports it, a plain data copy otherwise) placed at `<run dir>/sandbox` (under `.jaiph/runs/` by default) — and bind-mounts that snapshot read-write at `/jaiph/workspace`. The live host workspace is never mounted into the container: host edits during the run are invisible to it, and the container's workspace writes are discarded when the snapshot is deleted at exit.

The host checkout is unmodified after the run. Run artifacts always land under host `.jaiph/runs/` via a separate read-write mount, and the snapshot source is masked from the container's own `/jaiph/run` view by a tmpfs so the run cannot read it back.

Snapshot mode **never elevates**: the container runs with `--cap-drop ALL` and **zero** cap-adds, `--security-opt no-new-privileges`, no `--device`, no AppArmor exception, and on Linux as your own UID/GID from the first instruction. There is no device probing and no capability-posture knob to tune.

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

- `Docker sandbox, snapshot` — default snapshot mode.
- `Docker sandbox, in-place` — inplace mode.
- `Docker sandbox, unsafe` — `--unsafe` / `JAIPH_UNSAFE=true` opted out of the sandbox (Docker off, host-only).
- `no sandbox` — Docker is off for another reason (the Windows host-only override, or an explicit `JAIPH_DOCKER_ENABLED=false`).

Run artifacts always land under host `.jaiph/runs/<date>/<time>-<entry>/` regardless of mode. Open `run_summary.jsonl` there to inspect the live `__JAIPH_EVENT__` timeline the CLI also rendered.

## Related

- [Sandboxing](sandboxing.md) — the model: what each mode protects, what it does not.
- [Sandboxing — Runtime image toolchain](sandboxing.md#runtime-image-toolchain) — preinstalled CLI tools inside the default image.
- [Authenticate agent backends](/how-to/agent-auth) — getting credentials into the container.
- [Architecture — Docker runtime helper](architecture.md#core-components) — how the host CLI builds the `docker run` invocation.
