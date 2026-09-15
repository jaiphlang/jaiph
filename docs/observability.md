---
title: Export traces to an OTLP collector
permalink: /how-to/observability
diataxis: how-to
---

# Export traces to an OTLP collector

Every Jaiph run produces a complete, credential-redacted event timeline in `run_summary.jsonl` (see [Architecture](architecture.md#durable-artifact-layout)). The steps below turn that timeline into one OpenTelemetry trace per run, exported over OTLP/HTTP with a JSON payload to any collector that accepts OTLP (a local `otel-collector`, Grafana Tempo, Honeycomb, Datadog). Export runs on the host after a run reaches its terminal state.

## Prerequisites

- A `.jh` file you can run, and a collector endpoint that accepts OTLP/HTTP.
- The `OTEL_*` and `SENTRY_*` names Jaiph reads live in [the telemetry variables reference](env-vars.md#telemetry-variables); this recipe only shows which to set.

## 1. Point Jaiph at a collector

Export stays off until you set a standard OpenTelemetry endpoint variable (not a `JAIPH_*` one). Set the generic base, to which Jaiph appends `/v1/traces`, or the traces-specific endpoint, used exactly as given (it wins if both are set):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
jaiph run ./flows/review.jh "review this diff"
```

Every terminal run then posts exactly one trace, covering interactive `jaiph run`, standalone `jaiph run --raw`, and every def invoked through `jaiph mcp` or `jaiph serve`.

## 2. Try it against a local collector

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector:latest
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" jaiph run ./hello.jh
```

A hosted backend usually wants the traces endpoint plus an auth header, both set through the same [telemetry variables](env-vars.md#telemetry-variables) (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`).

## 3. Read the trace

One run becomes one trace whose id is the run's UUID with the dashes removed, so a re-export never creates a second trace. The root span (`run <name>`) covers `RUN_START` to `RUN_END` and is ERROR on a nonzero exit or signal; one child step span per step, nested by the run tree, carries the `jaiph.step.*` attributes; a prompt span under its step carries the `jaiph.prompt.*` attributes. The payload comes entirely from the redacted `run_summary.jsonl`, so a secret arrives as `[REDACTED]`. Every trace carries `jaiph.version`, `jaiph.run_id`, `jaiph.def`, and `jaiph.source` as resource attributes, plus `jaiph.principal` and `jaiph.correlation_id` for a `jaiph serve` run.

## 4. Report failed runs to Sentry {#report-failed-runs-to-sentry}

Traces cover every run; a Sentry error report covers only the runs that fail. Set a DSN — again a standard variable, not a `JAIPH_*` one — and each failing run posts one error event:

```bash
export SENTRY_DSN="https://<key>@<host>/<projectId>"
jaiph run ./deploy.jh
```

The `event_id` is the run's dashless UUID (so re-reporting keeps the id), the message names the exit or signal, and the `tags`, `extra`, and `fingerprint` come from the same redacted journal; a `jaiph serve` run also tags `jaiph.principal` and `jaiph.correlation_id`. `SENTRY_ENVIRONMENT` and `SENTRY_RELEASE` set the event's environment and release. A malformed DSN writes one stderr warning and sends nothing.

## 5. Know the failure and integrity rules

An export or report never changes the run: an unreachable or erroring backend writes exactly one stderr warning, and the run's exit code, output, and journal are unchanged, with no retries. Jaiph skips an export when the run's journal fails its keyed integrity chain, so a tampered timeline is never posted (see [Architecture — Keyed hash chain](architecture.md#hash-chain)). The two exporters run concurrently under one flush budget, `JAIPH_TELEMETRY_FLUSH_MS` (default 10 s); in the long-lived `jaiph serve` and `jaiph mcp` processes, delivery is detached so an unreachable backend never delays a terminal result. Jaiph speaks only OTLP/HTTP with a JSON payload and skips the export if `OTEL_EXPORTER_OTLP_PROTOCOL` names anything but `http/json`.

## Verification

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector:latest &
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" jaiph run ./hello.jh
```

The collector logs one received trace whose root span is `run hello`, and the run's own stderr carries no export warning. A failing run with `SENTRY_DSN` set additionally produces one Sentry event whose `event_id` is the run's dashless UUID.

## Related

- [Telemetry variables in the environment variables reference](env-vars.md#telemetry-variables) lists every `OTEL_*` and `SENTRY_*` name Jaiph reads.
- [The durable artifact layout in Architecture](architecture.md#durable-artifact-layout) describes the `run_summary.jsonl` timeline both exporters read.
