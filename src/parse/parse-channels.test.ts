import test from "node:test";
import assert from "node:assert/strict";
import { parseChannelLine } from "./channels";

// === parseChannelLine ===

test("parseChannelLine: parses valid channel declaration", () => {
  const result = parseChannelLine("test.jh", "  channel inbox", 5);
  assert.equal(result.name, "inbox");
  assert.equal(result.loc.line, 5);
  assert.equal(result.loc.col, 11);
  assert.equal(result.routes, undefined);
});

test("parseChannelLine: parses channel with underscore name", () => {
  const result = parseChannelLine("test.jh", "channel my_channel", 1);
  assert.equal(result.name, "my_channel");
  assert.equal(result.loc.line, 1);
  assert.equal(result.loc.col, 9);
});

test("parseChannelLine: parses channel with alphanumeric name", () => {
  const result = parseChannelLine("test.jh", "channel ch2", 3);
  assert.equal(result.name, "ch2");
});

// Name columns come from the name token, not `raw.indexOf(name)`, so a name
// that also occurs inside the word `channel` still reports column 9.
test("parseChannelLine: name col is the name token, not a substring of 'channel'", () => {
  assert.equal(parseChannelLine("test.jh", "channel c", 1).loc.col, 9);
  assert.equal(parseChannelLine("test.jh", "channel abc", 1).loc.col, 9);
  const routed = parseChannelLine("test.jh", "channel ch -> target", 1);
  assert.equal(routed.loc.col, 9);
  assert.equal(routed.routes![0].loc.col, 15);
});

test("parseChannelLine: parses channel with single route target", () => {
  const result = parseChannelLine("test.jh", "channel findings -> analyst", 1);
  assert.equal(result.name, "findings");
  assert.ok(result.routes);
  assert.equal(result.routes!.length, 1);
  assert.equal(result.routes![0].value, "analyst");
});

test("parseChannelLine: parses channel with multiple route targets", () => {
  const result = parseChannelLine("test.jh", "channel findings -> analyst, auditor", 1);
  assert.equal(result.name, "findings");
  assert.ok(result.routes);
  assert.equal(result.routes!.length, 2);
  assert.equal(result.routes![0].value, "analyst");
  assert.equal(result.routes![1].value, "auditor");
});

test("parseChannelLine: parses channel with module-qualified route target", () => {
  const result = parseChannelLine("test.jh", "channel findings -> lib.analyst", 1);
  assert.equal(result.name, "findings");
  assert.ok(result.routes);
  assert.equal(result.routes!.length, 1);
  assert.equal(result.routes![0].value, "lib.analyst");
});

test("parseChannelLine: rejects missing channel name", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: rejects channel with extra tokens", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel foo bar", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: rejects channel name starting with digit", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel 1bad", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: rejects channel with special characters", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel my-channel", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: error message mentions expected format", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel", 2),
    (err: any) => err.message.includes("invalid channel declaration") && err.message.includes("channel <name>"),
  );
});
