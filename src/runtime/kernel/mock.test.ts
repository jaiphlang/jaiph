import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readNextMockResponse, mockDispatch } from "./mock";

function tmpFile(name: string): string {
  const dir = join(tmpdir(), `jaiph-mock-test-${process.pid}`);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return join(dir, name);
}

describe("readNextMockResponse", () => {
  let mockFile: string;

  beforeEach(() => {
    mockFile = tmpFile("mock-responses.txt");
  });

  afterEach(() => {
    try { unlinkSync(mockFile); } catch { /* ok */ }
  });

  it("reads and consumes first line", () => {
    writeFileSync(mockFile, "first\nsecond\nthird\n", "utf8");
    const result = readNextMockResponse(mockFile);
    assert.equal(result, "first");
    const remaining = readFileSync(mockFile, "utf8");
    assert.equal(remaining, "second\nthird\n");
  });

  it("returns null when file is empty", () => {
    writeFileSync(mockFile, "", "utf8");
    const result = readNextMockResponse(mockFile);
    assert.equal(result, null);
  });

  it("returns null for missing file", () => {
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const result = readNextMockResponse("/nonexistent/path");
    process.stderr.write = origWrite;
    assert.equal(result, null);
  });

  it("handles single-line file", () => {
    writeFileSync(mockFile, "only-line\n", "utf8");
    const result = readNextMockResponse(mockFile);
    assert.equal(result, "only-line");
  });
});

describe("mockDispatch", () => {
  let scriptPath: string;

  beforeEach(() => {
    scriptPath = tmpFile("dispatch.sh");
  });

  afterEach(() => {
    try { unlinkSync(scriptPath); } catch { /* ok */ }
  });

  it("runs script and returns stdout", () => {
    writeFileSync(scriptPath, '#!/bin/bash\necho "mock-response"', { mode: 0o755 });
    const result = mockDispatch("test prompt", scriptPath);
    assert.equal(result.status, 0);
    assert.equal(result.response.trim(), "mock-response");
  });

  it("returns non-zero status on script failure", () => {
    writeFileSync(scriptPath, "#!/bin/bash\nexit 1", { mode: 0o755 });
    const result = mockDispatch("test prompt", scriptPath);
    assert.equal(result.status, 1);
  });

  it("returns status 1 for missing script", () => {
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const result = mockDispatch("test", "/nonexistent/script");
    process.stderr.write = origWrite;
    assert.equal(result.status, 1);
  });

  it("passes prompt text as first argument", () => {
    writeFileSync(scriptPath, '#!/bin/bash\nprintf "%s" "$1"', { mode: 0o755 });
    const result = mockDispatch("hello world", scriptPath);
    assert.equal(result.status, 0);
    assert.equal(result.response, "hello world");
  });
});
