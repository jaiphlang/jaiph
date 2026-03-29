import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunModuleLaunch } from "./workflow-launch";

test("buildRunModuleLaunch always uses node runner", () => {
  const launch = buildRunModuleLaunch(
    ["/tmp/meta.txt", "/tmp/workflow.sh", "entry", "a"],
    { JAIPH_SOURCE_ABS: "/tmp/source.jh" },
  );
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.args[1], "/tmp/meta.txt");
  assert.equal(launch.args[2], "/tmp/source.jh");
  assert.equal(launch.args[3], "/tmp/workflow.sh");
  assert.equal(launch.args[4], "default");
  assert.equal(launch.args[5], "a");
});

test("buildRunModuleLaunch throws without JAIPH_SOURCE_ABS", () => {
  assert.throws(
    () => buildRunModuleLaunch(["/tmp/meta.txt", "/tmp/workflow.sh", "entry"], {}),
    /JAIPH_SOURCE_ABS is required/,
  );
});
