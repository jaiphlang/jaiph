import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunModuleLaunch } from "./workflow-launch";

test("buildRunModuleLaunch uses generated module by default", () => {
  const launch = buildRunModuleLaunch(
    ["/tmp/meta.txt", "/tmp/workflow.sh", "entry", "a", "b"],
    {},
  );
  assert.equal(launch.command, "/tmp/workflow.sh");
  assert.deepEqual(launch.args, ["__jaiph_workflow", "default", "a", "b"]);
  assert.equal(launch.env.JAIPH_META_FILE, "/tmp/meta.txt");
});

test("buildRunModuleLaunch uses node runner in node orchestrator mode", () => {
  const launch = buildRunModuleLaunch(
    ["/tmp/meta.txt", "/tmp/workflow.sh", "entry", "a"],
    { JAIPH_NODE_ORCHESTRATOR: "1", JAIPH_SOURCE_ABS: "/tmp/source.jh" },
  );
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.args[1], "/tmp/meta.txt");
  assert.equal(launch.args[2], "/tmp/source.jh");
  assert.equal(launch.args[3], "/tmp/workflow.sh");
  assert.equal(launch.args[4], "default");
});
