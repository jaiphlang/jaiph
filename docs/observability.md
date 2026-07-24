---
title: Export traces to an OTLP collector
permalink: /how-to/observability
diataxis: how-to
---

# Export traces to an OTLP collector

Every Jaiph run already produces a complete, credential-redacted event timeline
(`run_summary.jsonl` — see [Architecture](architecture.md#durable-artifact-layout)).
This recipe turns that timeline into an **OpenTelemetry trace**: one span tree per
run, exported over OTLP/HTTP (JSON) to any collector — a local
[`otel-collector`](https://opentelemetry.io/docs/collector/), Grafana Tempo,
Honeycomb, Datadog, or anything else that speaks OTLP.

Export is **host-side and end-of-run**: after a run reaches its terminal state the
CLI reads that run's `run_summary.jsonl` and posts one trace. Nothing new crosses
the sandbox boundary, and no `OTEL_*` variable is forwarded into the container —
the run directory is a host mount, so the host already sees the finished journal.

## Enable it

Export is off until you point Jaiph at a collector with the standard OpenTelemetry
environment variables — there are **no `JAIPH_*` variables** for this feature. Set
either the traces-specific endpoint (used verbatim) or the generic base endpoint
(`/v1/traces` is appended):

```bash
# Generic base — Jaiph appends /v1/traces
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"

# …or the traces-specific endpoint, used exactly as given (wins if both are set)
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://localhost:4318/v1/traces"

jaiph run ./flows/review.jh "review this diff"
```

Every `jaiph run` completion and every workflow invoked through `jaiph mcp` /
`jaiph serve` then posts exactly one trace.

### A local collector

Run a collector that logs what it receives, then run a workflow against it:

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector:latest
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" jaiph run ./hello.jh
```

### A hosted backend (Honeycomb)

Hosted backends want the traces endpoint plus an auth header. Headers are a
comma-separated `key=value` list:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://api.honeycomb.io/v1/traces"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_API_KEY"
export OTEL_SERVICE_NAME="jaiph-ci"
jaiph run ./deploy.jh
```

Set `OTEL_RESOURCE_ATTRIBUTES="deployment.environment=prod,team=platform"` to tag
every span with extra resource attributes.

## What maps to what

One run becomes one trace. The **trace id** is the run's UUID with dashes stripped;
re-exporting the same run produces byte-identical ids, so a retry never forks the
trace.

- **Root span** `workflow <name>` — spans the whole run (`WORKFLOW_START` →
  `WORKFLOW_END`). Its status is **ERROR** when the run exits nonzero or a signal
  terminated it, otherwise **OK**. Each `logerr` / `logwarn` becomes a span event
  on this root.
- **Step spans** — one per step, nested by the run tree (a step's parent is the
  step that invoked it; top-level steps hang off the root). Attributes:
  `jaiph.step.kind` (`workflow` / `rule` / `script` / `prompt`), `jaiph.step.func`,
  `jaiph.step.name`, `jaiph.step.seq`, `jaiph.step.depth`, `jaiph.step.status`,
  `jaiph.step.elapsed_ms`, plus the redacted `jaiph.step.out` / `jaiph.step.err`
  captures. A nonzero step status is an ERROR span; a step with no end (a crash)
  closes at the last event's time as ERROR.
- **Prompt spans** — child of the step that issued the prompt, with
  `jaiph.prompt.backend`, `jaiph.prompt.model`, and `jaiph.prompt.status`.

The exported payload is sourced entirely from `run_summary.jsonl`, which is already
credential-redacted, so secrets in step output arrive as `[REDACTED]`. The raw
per-step capture files are never read.

## Failure is never load-bearing

Telemetry never affects a run. An unreachable or erroring collector produces
**exactly one** warning line on stderr; the run's exit code, output, and journal
are untouched. There are no retries and no queue — a run is minutes long, so
end-of-run batching is the normal OTLP pattern.

Only OTLP/HTTP with a JSON payload is spoken. If `OTEL_EXPORTER_OTLP_PROTOCOL` is
set to anything other than `http/json` (for example `grpc`), Jaiph warns and skips
the export rather than mis-speak a protocol.

## Report failed runs to Sentry

Traces cover every run; **Sentry** covers the runs you get paged about. When a run
terminates *unsuccessfully* (nonzero exit or a signal), Jaiph posts one Sentry
**error event** so operators get alerting and grouping without scraping run
directories. Successful runs send nothing.

Reporting is off until you set a Sentry **DSN** — there are, again, **no `JAIPH_*`
variables** for this feature:

```bash
export SENTRY_DSN="https://<key>@<host>/<projectId>"
export SENTRY_ENVIRONMENT="prod"   # optional — sets the event's environment
export SENTRY_RELEASE="jaiph@1.2.3" # optional — defaults to jaiph@<version>

jaiph run ./deploy.jh
```

The same host-side, end-of-run choke point that exports traces fires the report —
so `jaiph run` completions and workflows invoked through `jaiph mcp` / `jaiph serve`
are all covered. A malformed DSN produces exactly one stderr warning and no send.

### What the event carries

Everything is sourced from the run's `run_summary.jsonl` (already
credential-redacted), never from the raw `.out` / `.err` captures:

- **`event_id`** — the run's UUID with dashes stripped, so a re-report of the same
  run keeps the same id.
- **`message`** — `workflow <name> failed (exit N)`, or `terminated by signal S`.
- **`level`** `error`, **`platform`** `node`.
- **`tags`** — `jaiph.workflow`, `jaiph.source` (the source file basename), and the
  failing step's `jaiph.step.kind` / `jaiph.step.name` when known.
- **`extra`** — `failing_step_detail` (the failing step's redacted `err`/`out`
  excerpt) and `run_dir` (a pointer to the run directory for triage).
- **`fingerprint`** — `["jaiph", <workflow>, <failing step name or "unknown">]`, so
  re-occurrences group per workflow + failing step.
- **`release`** / **`environment`** — from `SENTRY_RELEASE` / `SENTRY_ENVIRONMENT`.

### Failure is never load-bearing

Like trace export, a Sentry report never affects a run. An unreachable or erroring
Sentry, a malformed DSN, or a timeout (10 s) produces **exactly one** stderr warning
line; the run's exit code, output, and journal are untouched. There are no retries.

## Related

- [Environment variables — Telemetry variables](env-vars.md#telemetry-variables) — the full list of consumed `OTEL_*` / `SENTRY_*` names.
- [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) — the `run_summary.jsonl` timeline both exporters read.
