import test from "node:test";
import assert from "node:assert/strict";
import { main } from "./index";
import { WORKFLOW_RUNNER_ARG } from "../runtime/kernel/node-workflow-runner";
import { printUsage } from "./shared/usage";

interface StreamCapture {
  text: string;
  restore: () => void;
}

function captureStream(stream: NodeJS.WriteStream): StreamCapture {
  const original = stream.write.bind(stream);
  const buf: string[] = [];
  (stream.write as unknown) = (chunk: string | Uint8Array): boolean => {
    buf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return {
    get text() {
      return buf.join("");
    },
    restore() {
      stream.write = original;
    },
  };
}

test(`main dispatches ${WORKFLOW_RUNNER_ARG} to the runner instead of falling through to "Unknown command"`, async () => {
  const err = captureStream(process.stderr);
  try {
    // No positional args after the marker — runner's parser must reject this
    // before the dispatch can route anywhere else.
    const code = await main(["node", "cli.js", WORKFLOW_RUNNER_ARG]);
    assert.equal(code, 1);
  } finally {
    err.restore();
  }
  assert.match(err.text, /node-workflow-runner requires meta file and source file/);
  assert.doesNotMatch(err.text, /Unknown command/);
});

test(`printUsage never mentions the internal ${WORKFLOW_RUNNER_ARG} marker`, () => {
  const out = captureStream(process.stdout);
  try {
    printUsage();
  } finally {
    out.restore();
  }
  assert.doesNotMatch(out.text, new RegExp(WORKFLOW_RUNNER_ARG));
});

test("--help output never mentions the internal __workflow-runner marker", async () => {
  const out = captureStream(process.stdout);
  let code: number;
  try {
    code = await main(["node", "cli.js", "--help"]);
  } finally {
    out.restore();
  }
  assert.equal(code, 0);
  assert.doesNotMatch(out.text, /__workflow-runner/);
});
