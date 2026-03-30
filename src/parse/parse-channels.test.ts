import test from "node:test";
import assert from "node:assert/strict";
import { parseChannelLine } from "./channels";

// === parseChannelLine ===

test("parseChannelLine: parses valid channel declaration", () => {
  const result = parseChannelLine("test.jh", "channel inbox", "  channel inbox", 5);
  assert.equal(result.name, "inbox");
  assert.equal(result.loc.line, 5);
  assert.equal(result.loc.col, 11);
});

test("parseChannelLine: parses channel with underscore name", () => {
  const result = parseChannelLine("test.jh", "channel my_channel", "channel my_channel", 1);
  assert.equal(result.name, "my_channel");
  assert.equal(result.loc.line, 1);
  assert.equal(result.loc.col, 9);
});

test("parseChannelLine: parses channel with alphanumeric name", () => {
  const result = parseChannelLine("test.jh", "channel ch2", "channel ch2", 3);
  assert.equal(result.name, "ch2");
});

test("parseChannelLine: rejects missing channel name", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel", "channel", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: rejects channel with extra tokens", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel foo bar", "channel foo bar", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: rejects channel name starting with digit", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel 1bad", "channel 1bad", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: rejects channel with special characters", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel my-channel", "channel my-channel", 1),
    /E_PARSE/,
  );
});

test("parseChannelLine: error message mentions expected format", () => {
  assert.throws(
    () => parseChannelLine("test.jh", "channel", "channel", 2),
    (err: any) => err.message.includes("invalid channel declaration") && err.message.includes("channel <name>"),
  );
});
