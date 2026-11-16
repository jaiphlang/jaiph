import test from "node:test";
import assert from "node:assert/strict";
import { safeDecodeSegment, safeCorrelationId, contentDisposition } from "./http-util";

// === safeDecodeSegment ===

test("safeDecodeSegment decodes a well-formed segment", () => {
  assert.equal(safeDecodeSegment("a%20b"), "a b");
  assert.equal(safeDecodeSegment("%E6%8A%A5%E5%91%8A.txt"), "报告.txt");
});

test("safeDecodeSegment returns null for malformed percent-encoding (never throws)", () => {
  assert.equal(safeDecodeSegment("%zz"), null);
  assert.equal(safeDecodeSegment("%"), null);
  assert.equal(safeDecodeSegment("%E0%A4%A"), null);
});

// === safeCorrelationId ===

test("safeCorrelationId accepts an audit-safe token", () => {
  assert.equal(safeCorrelationId("req-123_abc.def:9"), "req-123_abc.def:9");
  assert.equal(safeCorrelationId("  trimmed  "), "trimmed");
});

test("safeCorrelationId rejects whitespace, '=', and newlines so it cannot forge a key=value pair", () => {
  assert.equal(safeCorrelationId("x principal=operator"), null);
  assert.equal(safeCorrelationId("a=b"), null);
  assert.equal(safeCorrelationId("line1\nline2"), null);
  assert.equal(safeCorrelationId(""), null);
  assert.equal(safeCorrelationId(undefined), null);
});

test("safeCorrelationId rejects an over-long value (>128 chars)", () => {
  assert.equal(safeCorrelationId("a".repeat(128)), "a".repeat(128));
  assert.equal(safeCorrelationId("a".repeat(129)), null);
});

// === contentDisposition ===

test("contentDisposition carries an ASCII fallback and an RFC 5987 UTF-8 name for a non-ASCII file", () => {
  const header = contentDisposition("报告.txt");
  // ASCII fallback replaces the non-ASCII bytes so node:http can set the header.
  assert.match(header, /^attachment; filename="__\.txt"; filename\*=UTF-8''/);
  // The real name survives, percent-encoded, in filename*.
  assert.ok(header.includes("filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt"), header);
  // The whole header is settable: printable ASCII only.
  assert.match(header, /^[\x20-\x7e]*$/);
});

test("contentDisposition escapes/replaces quote and backslash in the ASCII fallback", () => {
  const header = contentDisposition('a"b\\c.txt');
  assert.match(header, /filename="a_b_c\.txt"/);
  // The real name is recoverable from filename* (quote/backslash percent-encoded).
  assert.ok(header.includes("filename*=UTF-8''a%22b%5Cc.txt"), header);
  assert.match(header, /^[\x20-\x7e]*$/);
});

test("contentDisposition leaves a plain ASCII name intact in the fallback", () => {
  assert.equal(
    contentDisposition("result.txt"),
    "attachment; filename=\"result.txt\"; filename*=UTF-8''result.txt",
  );
});
