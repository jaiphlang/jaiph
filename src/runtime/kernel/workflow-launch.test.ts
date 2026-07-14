import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunModuleLaunch } from "./workflow-launch";
import { WORKFLOW_RUNNER_ARG } from "./node-workflow-runner";

test("buildRunModuleLaunch routes through the __workflow-runner dispatch (node build)", () => {
  const launch = buildRunModuleLaunch(
    ["/tmp/meta.txt", "/tmp/workflow.sh", "entry", "a"],
    { JAIPH_SOURCE_ABS: "/tmp/source.jh" },
  );
  assert.equal(launch.command, process.execPath);
  // Node build: [cli.js, __workflow-runner, meta, source, built, workflowSymbol, ...runArgs]
  assert.match(launch.args[0]!, /cli\.js$/);
  assert.equal(launch.args[1], WORKFLOW_RUNNER_ARG);
  assert.equal(launch.args[2], "/tmp/meta.txt");
  assert.equal(launch.args[3], "/tmp/source.jh");
  assert.equal(launch.args[4], "/tmp/workflow.sh");
  assert.equal(launch.args[5], "entry");
  assert.equal(launch.args[6], "a");
  assert.equal(launch.env.JAIPH_META_FILE, "/tmp/meta.txt");
});

test("buildRunModuleLaunch passes the requested workflow symbol through to the runner argv", () => {
  // Pins the fixed hardcoded-"default" bug: the symbol must reach the runner
  // verbatim, otherwise every jaiph run / MCP call would execute `default`.
  const launch = buildRunModuleLaunch(
    ["meta", "built.sh", "mywf", "arg1"],
    { JAIPH_SOURCE_ABS: "/tmp/source.jh" },
  );
  assert.ok(launch.args.includes("mywf"), `argv should contain the workflow symbol: ${launch.args.join(" ")}`);
  // The symbol occupies the workflowSymbol slot, immediately before its run args.
  const symbolIdx = launch.args.indexOf("mywf");
  assert.equal(launch.args[symbolIdx + 1], "arg1");
});

test("buildRunModuleLaunch falls back to 'default' when the workflow symbol is empty", () => {
  const launch = buildRunModuleLaunch(
    ["/tmp/meta.txt", "/tmp/workflow.sh", "", "a"],
    { JAIPH_SOURCE_ABS: "/tmp/source.jh" },
  );
  // [cli.js, __workflow-runner, meta, source, built, "default", "a"]
  assert.equal(launch.args[5], "default");
  assert.equal(launch.args[6], "a");
});

test("buildRunModuleLaunch throws without JAIPH_SOURCE_ABS", () => {
  assert.throws(
    () => buildRunModuleLaunch(["/tmp/meta.txt", "/tmp/workflow.sh", "entry"], {}),
    /JAIPH_SOURCE_ABS is required/,
  );
});
