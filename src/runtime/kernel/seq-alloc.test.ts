import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateNextSeq } from "./seq-alloc";

test("allocateNextSeq returns monotonic unique values", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-seq-"));
  try {
    writeFileSync(join(dir, ".seq"), "0");
    const seqs = [];
    for (let i = 0; i < 10; i++) {
      seqs.push(allocateNextSeq(dir));
    }
    assert.deepStrictEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(readFileSync(join(dir, ".seq"), "utf8"), "10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allocateNextSeq starts from existing value", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-seq-"));
  try {
    writeFileSync(join(dir, ".seq"), "42");
    assert.equal(allocateNextSeq(dir), 43);
    assert.equal(allocateNextSeq(dir), 44);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
