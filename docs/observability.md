---
title: Export traces to an OTLP collector
permalink: /how-to/observability
diataxis: how-to
---

# Export traces to an OTLP collector

Every Jaiph run produces a complete event timeline with credentials redacted,
written to `run_summary.jsonl` (see [Architecture](architecture.md#durable-artifact-layout)).
The steps below turn that timeline into an OpenTelemetry trace, which is one span
tree per run. Jaiph exports the trace over OTLP/HTTP with a JSON payload to any
collector that accepts OTLP, such as a local
[`otel-collector`](https://opentelemetry.io/docs/collector/), Grafana Tempo,
Honeycomb, or Datadog.

Export runs on the host after the run finishes. Once a run reaches its terminal
state, the CLI reads that run's `run_summary.jsonl` and posts one trace.

## Enable it

Export stays off until you point Jaiph at a collector with the standard
OpenTelemetry environment variables. You enable it with those variables, not with
a `JAIPH_*` variable. Set either the traces endpoint, which Jaiph uses exactly as
given, or the generic base endpoint, to which Jaiph appends `/v1/traces`:

```bash
# Generic base — Jaiph appends /v1/traces
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"

# …or the traces-specific endpoint, used exactly as given (wins if both are set)
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://localhost:4318/v1/traces"

jaiph run ./flows/review.jh "review this diff"
```

Every terminal run posts exactly one trace, covering an interactive `jaiph run`, a
standalone `jaiph run --raw`, and every def invoked through `jaiph mcp` or
`jaiph serve`.

### A local collector

Run a collector that logs what it receives, then run a def against it:

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector:latest
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" jaiph run ./hello.jh
```

### A hosted backend (Honeycomb)

A hosted backend usually wants the traces endpoint plus an auth header. Headers are
a comma-separated list of `key=value` pairs:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://api.honeycomb.io/v1/traces"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_API_KEY"
export OTEL_SERVICE_NAME="jaiph-ci"
jaiph run ./deploy.jh
```

Set `OTEL_RESOURCE_ATTRIBUTES="deployment.environment=prod,team=platform"` to add
extra resource attributes to every span.

## What maps to what

One run becomes one trace. The trace id is the run's UUID with the dashes removed.
Re-exporting the same run produces the same ids, so a retry never creates a second
trace.

- **Root span** (`run <name>`) covers the whole run, from `RUN_START` to
  `RUN_END`. Its status is ERROR when the run exits nonzero or a signal
  terminated it, and OK otherwise. Each `logerr` and `logwarn` becomes a span event
  on this root span.
- **Step spans**, one per step. Steps nest by the run tree, so a step's parent is
  the step that invoked it, and top-level steps hang off the root. Each step span
  carries these attributes: `jaiph.step.kind` (`def`, `script`, or
  `prompt`), `jaiph.step.func`, `jaiph.step.name`, `jaiph.step.seq`,
  `jaiph.step.depth`, `jaiph.step.status`, `jaiph.step.elapsed_ms`, and the redacted
  `jaiph.step.out` and `jaiph.step.err` captures. A step with a nonzero status is an
  ERROR span. A step with no end, which happens on a crash, closes at the last
  event's time and is marked ERROR.
- **Prompt spans** are a child of the step that issued the prompt. Each prompt span
  carries `jaiph.prompt.backend`, `jaiph.prompt.model`, and `jaiph.prompt.status`.

The exported payload comes entirely from `run_summary.jsonl`, which is already
credential-redacted, so a secret in step output arrives as `[REDACTED]`. Jaiph
never reads the raw per-step capture files for the export.

Beyond the service name, every trace carries `jaiph.version`, `jaiph.run_id`,
`jaiph.def`, and `jaiph.source` as resource attributes. You can add your own
with `OTEL_RESOURCE_ATTRIBUTES`, and you can set the service name with
`OTEL_SERVICE_NAME` (the default is `jaiph`).

An authenticated `jaiph serve` run also carries the caller's identity as resource
attributes. `jaiph.principal` is the audit subject, which is the token `sub` (or
`client_id` for `sub`-less machine tokens) in OIDC mode and `operator` or
`anonymous` otherwise. `jaiph.correlation_id` is the
request's `X-Correlation-Id` or `X-Request-Id`, or a generated UUID when neither is
present. Both attributes are attached to every span of the trace, and neither is
ever a bearer token or any value that carries a secret. They are absent for `jaiph
run` and for anonymous callers.

## What happens when an export fails

An export that fails never changes the run. If the collector is unreachable or
returns an error, Jaiph writes exactly one warning line to stderr, and the run's
exit code, output, and journal are unchanged. There are no retries and no queue. A
run takes minutes, so batching the export at the end of the run is the normal OTLP
pattern.

Jaiph also skips an export when the run's journal fails its keyed integrity
chain. Each exporter verifies the chain before it reads `run_summary.jsonl`.
When the chain does not verify, because the journal was rewritten, truncated, or
forged, Jaiph writes one warning line and skips the export, so a tampered
timeline is never posted to the collector or to Sentry. A run with no persisted
key cannot be verified and is exported normally. See
[Architecture — Keyed hash chain](architecture.md#hash-chain).

The OTLP-trace exporter and the Sentry exporter run concurrently under one total
flush budget, set by `JAIPH_TELEMETRY_FLUSH_MS` with a default of 10 seconds, so
the whole post-run flush is bounded by that budget rather than by the sum of two
sequential timeouts. In the long-lived `jaiph serve` and `jaiph mcp` processes,
delivery is detached. Jaiph marks the run terminal and releases its
execution-concurrency slot before it attempts delivery, so an unreachable backend
can never delay a terminal result or hold a slot. When detached delivery fails,
Jaiph counts it as a bounded metric and prints a capped number of stderr warnings.

Jaiph speaks only OTLP/HTTP with a JSON payload. If `OTEL_EXPORTER_OTLP_PROTOCOL`
is set to anything other than `http/json`, for example `grpc`, Jaiph writes a
warning and skips the export rather than send the wrong protocol.

## Report failed runs to Sentry

Traces cover every run. A Sentry error report covers only the runs that fail. When
a run terminates unsuccessfully, from a nonzero exit or a signal, Jaiph posts one
Sentry error event, which gives operators alerting and grouping without reading
through run directories. A successful run sends nothing.

Reporting stays off until you set a Sentry DSN. As with traces, you enable it with
a standard variable, not a `JAIPH_*` variable:

```bash
export SENTRY_DSN="https://<key>@<host>/<projectId>"
export SENTRY_ENVIRONMENT="prod"   # optional — sets the event's environment
export SENTRY_RELEASE="jaiph@1.2.3" # optional — defaults to jaiph@<version>

jaiph run ./deploy.jh
```

The same host-side, end-of-run step that exports traces also sends the report. So
`jaiph run` completions, including a standalone `jaiph run --raw`, and defs
invoked through `jaiph mcp` or `jaiph serve` are all covered, and each one produces
one Sentry event when it fails. If the DSN is malformed, Jaiph writes exactly one
stderr warning and sends nothing.

### What the event carries

Everything comes from the run's `run_summary.jsonl`, which is already
credential-redacted. Jaiph never reads the raw `.out` or `.err` captures for the
report.

- **`event_id`** is the run's UUID with the dashes removed, so re-reporting the
  same run keeps the same id.
- **`message`** is `run <name> failed (exit N)`, or `run <name>
  terminated by signal S`.
- **`level`** is `error`, and **`platform`** is `node`.
- **`tags`** include `jaiph.def`, `jaiph.source` (the source file basename),
  and the failing step's `jaiph.step.kind` and `jaiph.step.name` when they are
  known. An authenticated `jaiph serve` run also tags `jaiph.principal` (the audit
  subject) and `jaiph.correlation_id` (the request id), never a token or any value
  that carries a secret.
- **`extra`** holds `failing_step_detail` (the failing step's redacted `err` or
  `out` excerpt) and `run_dir` (a pointer to the run directory for triage).
- **`fingerprint`** is `["jaiph", <def>, <failing step name or "unknown">]`,
  so re-occurrences group by def and failing step.
- **`release`** and **`environment`** come from `SENTRY_RELEASE` and
  `SENTRY_ENVIRONMENT`.

### What happens when a report fails

Like a trace export, a Sentry report never affects a run. If Sentry is unreachable
or returns an error, if the DSN is malformed, or if the send times out (bounded by
the shared `JAIPH_TELEMETRY_FLUSH_MS` budget, default 10 seconds), Jaiph writes
exactly one stderr warning line. The run's exit code, output, and journal are
unchanged, and there are no retries.

## Related

- [Telemetry variables in the environment variables reference](env-vars.md#telemetry-variables) lists every `OTEL_*` and `SENTRY_*` name Jaiph reads.
- [The durable artifact layout in Architecture](architecture.md#durable-artifact-layout) describes the `run_summary.jsonl` timeline both exporters read.
