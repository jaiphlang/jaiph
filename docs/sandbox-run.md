---
title: Run in a Docker sandbox
permalink: /how-to/sandbox-run
diataxis: how-to
---

# Run a workflow in a Docker sandbox

This guide runs a `.jh` workflow inside the Docker sandbox. It shows how to choose whether the run's file edits stay isolated from your workspace or land on it, and how to skip the confirmation prompt in continuous integration (CI).

For the design of the sandbox, including what it protects against and what it does not, see [Sandboxing](sandboxing.md). This page covers the steps to run a workflow, not the design.

## Prerequisites

- Docker is installed and `docker info` succeeds on the host.
- An entry `.jh` file with a `default` workflow.
- Agent credentials forwarded into the container when the workflow uses `prompt`. See [Authenticate agent backends](agent-auth.md).

## 1. Run with the default sandbox

```bash
jaiph run ./flow.jh
```

Docker is on by default. In the default snapshot mode the CLI takes a writable point-in-time snapshot of the workspace at run start. The snapshot is a host-side clone, made with a block-level copy-on-write where the filesystem supports it and a plain data copy otherwise. It lives inside the per-run directory (`<run dir>/sandbox`, under `.jaiph/runs/` by default), and the CLI bind-mounts it read-write into the container at `/jaiph/workspace`. The live host workspace is never mounted into the container, so host edits during the run are invisible to it, and the container's writes to the workspace are discarded when the snapshot is deleted at exit.

The snapshot content is defined by git. In a git workspace it contains exactly the files git tracks or reports as untracked but not ignored, plus `.git/`. Gitignored paths such as `node_modules/`, `.env`, and build output are absent, not just empty. A workflow that builds or tests therefore installs its dependencies inside the container with `npm install`, `pip install`, or the equivalent, the same as a fresh CI checkout. A non-git workspace falls back to copying everything. See [Sandboxing, what the snapshot contains](sandboxing.md#snapshot-content).

The host checkout is unmodified after the run. Run artifacts always land under the host `.jaiph/runs/` directory through a separate read-write mount, and a tmpfs masks the snapshot source from the container's own `/jaiph/run` view so the run cannot read it back.

Snapshot mode never raises the container's privileges. The container runs with `--cap-drop ALL` and zero cap-adds, `--security-opt no-new-privileges`, no `--device`, and no AppArmor exception. On Linux it runs as your own UID and GID. There is no device probing and no capability setting to tune.

## 2. Pick inplace mode for live edits

When you want the run's edits to land live on the host, which is typical for an agent-driven development loop, opt in to inplace mode:

```bash
jaiph run --inplace ./flow.jh
```

You can also set the environment variable to `1` or `true`:

```bash
JAIPH_INPLACE=1 jaiph run ./flow.jh
```

The `--inplace` flag sets `JAIPH_INPLACE=1` for one run only. The container's other protections stay in place, including `--cap-drop ALL`, `--security-opt no-new-privileges`, the environment-variable allowlist, and the mount allowlist. Only the workspace isolation is removed.

Before launch the CLI prints a warning that says the run can edit files directly in your workspace directory while the rest of your machine stays inside the Docker sandbox, and then it waits for you to answer `y`. The default answer on empty input or end of input is no.

## 3. Skip the inplace confirmation prompt in CI

When stdin is not a TTY, which is typical in CI, the inplace prompt cannot run interactively. Pass `-y` or `--yes` together with `--inplace`, or set `JAIPH_INPLACE_YES=1` or `JAIPH_INPLACE_YES=true`:

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

You can also set the environment variable:

```bash
JAIPH_UNSAFE=true jaiph run ./flow.jh
```

This disables Docker, so the workflow runs on the host with full access to your machine. Because that is more exposure than inplace, the CLI prints its own stronger warning and waits for `y` before launching, and the default answer is no. Skip it the same way as the inplace prompt, with `-y` or `--yes`, or `JAIPH_INPLACE_YES=1` or `JAIPH_INPLACE_YES=true`. In a non-TTY environment without one of these, the run aborts with `E_UNSAFE_NO_CONFIRM`. The prompt fires only when the unsafe opt-in is what turns Docker off. It does not fire when Docker is disabled for another reason, such as the Windows host-only override or an explicit `JAIPH_DOCKER_ENABLED=false`.

Combining `--unsafe` with `--inplace` is rejected with `E_FLAG_CONFLICT` before any container starts, because one keeps the sandbox on and the other turns it off.

## Verification

The CLI banner reports the sandbox mode it picked:

- `Docker sandbox, snapshot` is the default snapshot mode.
- `Docker sandbox, in-place` is inplace mode.
- `Docker sandbox, unsafe` means `--unsafe` or `JAIPH_UNSAFE=true` opted out of the sandbox, so Docker is off and the run is host-only.
- `no sandbox` means Docker is off for another reason, either the Windows host-only override or an explicit `JAIPH_DOCKER_ENABLED=false`.

Run artifacts always land under the host `.jaiph/runs/<date>/<time>-<entry>/` directory regardless of mode. Open `run_summary.jsonl` there to inspect the durable event timeline that the CLI also rendered as `__JAIPH_EVENT__` lines during the run.

## Related

- [Sandboxing](sandboxing.md) explains the model, including what each mode protects and what it does not.
- [Sandboxing, runtime image toolchain](sandboxing.md#runtime-image-toolchain) lists the CLI tools preinstalled in the default image.
- [Authenticate agent backends](agent-auth.md) covers getting credentials into the container.
- [Architecture, Docker runtime helper](architecture.md#core-components) shows how the host CLI builds the `docker run` invocation.
