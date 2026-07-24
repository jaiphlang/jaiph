import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSentryDsn,
  buildSentryEvent,
  buildEnvelope,
  reportRunFailureToSentry,
  type SentryEventMeta,
} from "./sentry";
import { VERSION } from "../../version";

const RUN_ID = "11111111-2222-3333-4444-555555555555";

/** A journal covering the root, a passing step, and a failing script step. */
function fixtureLines(): string[] {
  const events: Record<string, unknown>[] = [
    { type: "WORKFLOW_START", workflow: "default", source: "/abs/path/deploy.jh", ts: "2026-07-24T10:00:00Z", run_id: RUN_ID },
    { type: "STEP_START", func: "ok", kind: "script", name: "ok", ts: "2026-07-24T10:00:01Z", id: "R:2", run_id: RUN_ID },
    { type: "STEP_END", func: "ok", kind: "script", name: "ok", ts: "2026-07-24T10:00:02Z", status: 0, id: "R:2", run_id: RUN_ID, out_content: "fine\n", err_content: "" },
    { type: "STEP_START", func: "boom", kind: "script", name: "boom", ts: "2026-07-24T10:00:03Z", id: "R:3", run_id: RUN_ID },
    { type: "STEP_END", func: "boom", kind: "script", name: "boom", ts: "2026-07-24T10:00:04Z", status: 2, id: "R:3", run_id: RUN_ID, out_content: "", err_content: "kaboom\n" },
    { type: "WORKFLOW_END", workflow: "default", source: "/abs/path/deploy.jh", ts: "2026-07-24T10:00:05Z", run_id: RUN_ID },
  ];
  return events.map((e) => JSON.stringify(e));
}

const META: SentryEventMeta = {
  workflow: "default",
  exitStatus: 1,
  signal: null,
  runDir: "/abs/.jaiph/runs/2026-07-24/10-00-00-deploy",
  release: `jaiph@${VERSION}`,
};

// --- DSN parsing -----------------------------------------------------------

test("parseSentryDsn: endpoint + auth header from a well-formed DSN", () => {
  const parsed = parseSentryDsn("https://abc123@o1.ingest.sentry.io/42");
  assert.ok(parsed);
  assert.equal(parsed.endpoint, "https://o1.ingest.sentry.io/api/42/envelope/");
  assert.equal(parsed.authHeader, `Sentry sentry_version=7, sentry_key=abc123, sentry_client=jaiph/${VERSION}`);
});

test("parseSentryDsn: a non-default port is preserved in the endpoint", () => {
  const parsed = parseSentryDsn("https://key@localhost:9000/7");
  assert.ok(parsed);
  assert.equal(parsed.endpoint, "https://localhost:9000/api/7/envelope/");
});

test("parseSentryDsn: malformed DSNs return null (no send)", () => {
  assert.equal(parseSentryDsn("not a url"), null, "unparseable");
  assert.equal(parseSentryDsn("https://o1.ingest.sentry.io/42"), null, "missing public key");
  assert.equal(parseSentryDsn("https://key@host/"), null, "missing project id");
  assert.equal(parseSentryDsn("https://key@host/a/42"), null, "multi-segment path is not a bare project id");
});

// --- Event composition -----------------------------------------------------

test("buildSentryEvent: event_id is the run id UUID with dashes stripped", () => {
  const event = buildSentryEvent(fixtureLines(), META);
  assert.equal(event.event_id, "11111111222233334444555555555555");
  assert.match(event.event_id as string, /^[0-9a-f]{32}$/);
});

test("buildSentryEvent: exit-code termination message + fingerprint + tags + redacted-source excerpt", () => {
  const event = buildSentryEvent(fixtureLines(), META);
  assert.equal(event.platform, "node");
  assert.equal(event.level, "error");
  assert.deepEqual(event.message, { formatted: "workflow default failed (exit 1)" });
  assert.deepEqual(event.fingerprint, ["jaiph", "default", "boom"]);
  assert.equal(event.release, `jaiph@${VERSION}`);
  assert.equal((event as { environment?: string }).environment, undefined, "no environment key when unset");

  const tags = event.tags as Record<string, string>;
  assert.equal(tags["jaiph.workflow"], "default");
  assert.equal(tags["jaiph.source"], "deploy.jh", "source tag is the basename");
  assert.equal(tags["jaiph.step.kind"], "script");
  assert.equal(tags["jaiph.step.name"], "boom");

  const extra = event.extra as Record<string, string>;
  assert.equal(extra.failing_step_detail, "kaboom", "the failing step's err_content excerpt");
  assert.equal(extra.run_dir, META.runDir);
});

test("buildSentryEvent: signal termination wins over exit code in the message", () => {
  const event = buildSentryEvent(fixtureLines(), { ...META, exitStatus: 0, signal: "SIGKILL" });
  assert.deepEqual(event.message, { formatted: "workflow default terminated by signal SIGKILL" });
});

test("buildSentryEvent: environment is included only when set", () => {
  const event = buildSentryEvent(fixtureLines(), { ...META, environment: "prod" });
  assert.equal((event as { environment?: string }).environment, "prod");
});

test("buildSentryEvent: no failing step → fingerprint tail is 'unknown', no step tags", () => {
  const lines = [
    JSON.stringify({ type: "WORKFLOW_START", workflow: "default", source: "x.jh", ts: "2026-07-24T10:00:00Z", run_id: RUN_ID }),
    JSON.stringify({ type: "WORKFLOW_END", workflow: "default", source: "x.jh", ts: "2026-07-24T10:00:01Z", run_id: RUN_ID }),
  ];
  const event = buildSentryEvent(lines, { ...META, signal: "SIGTERM", exitStatus: 0 });
  assert.deepEqual(event.fingerprint, ["jaiph", "default", "unknown"]);
  const tags = event.tags as Record<string, string>;
  assert.equal(tags["jaiph.step.name"], undefined);
  assert.equal(tags["jaiph.step.kind"], undefined);
});

// --- Envelope framing ------------------------------------------------------

test("buildEnvelope: three newline-separated JSON documents (header, item header, event)", () => {
  const event = buildSentryEvent(fixtureLines(), META);
  const envelope = buildEnvelope(event, "2026-07-24T10:00:06Z");
  const docs = envelope.split("\n");
  assert.equal(docs.length, 3, "exactly three lines");

  const header = JSON.parse(docs[0]) as { event_id: string; sent_at: string };
  assert.equal(header.event_id, "11111111222233334444555555555555", "envelope header event_id matches run id hex");
  assert.equal(header.sent_at, "2026-07-24T10:00:06Z");

  const itemHeader = JSON.parse(docs[1]) as { type: string };
  assert.deepEqual(itemHeader, { type: "event" });

  const body = JSON.parse(docs[2]) as { event_id: string };
  assert.equal(body.event_id, header.event_id, "item event_id matches the envelope header");
});

// --- Enablement / failure gates (no network) -------------------------------

async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured.push(s);
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return captured;
}

test("reportRunFailureToSentry: a successful run sends nothing and warns nothing", async () => {
  const out = await captureStderr(() =>
    reportRunFailureToSentry({
      runDir: "/nonexistent",
      workflow: "default",
      exitStatus: 0,
      signal: null,
      env: { SENTRY_DSN: "https://key@host/1" },
    }),
  );
  assert.equal(out.length, 0);
});

test("reportRunFailureToSentry: a failed run without SENTRY_DSN sends nothing and warns nothing", async () => {
  const out = await captureStderr(() =>
    reportRunFailureToSentry({ runDir: "/nonexistent", workflow: "default", exitStatus: 1, signal: null, env: {} }),
  );
  assert.equal(out.length, 0);
});

test("reportRunFailureToSentry: a failed run with a malformed DSN warns exactly once and does not send", async () => {
  const out = await captureStderr(() =>
    reportRunFailureToSentry({
      runDir: "/nonexistent",
      workflow: "default",
      exitStatus: 1,
      signal: null,
      env: { SENTRY_DSN: "https://host/1" },
    }),
  );
  assert.equal(out.length, 1, "exactly one warning line");
  assert.match(out[0], /malformed SENTRY_DSN/);
});
