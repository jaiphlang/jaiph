import test from "node:test";
import assert from "node:assert/strict";
import { parseImportLine } from "./imports";

test("parseImportLine: parses valid double-quoted import", () => {
  const result = parseImportLine("test.jh", 'import "tools.jh" as tools', 'import "tools.jh" as tools', 1);
  assert.equal(result.path, "tools.jh");
  assert.equal(result.alias, "tools");
  assert.equal(result.loc.line, 1);
});

test("parseImportLine: parses valid single-quoted import", () => {
  const result = parseImportLine("test.jh", "import 'other.jh' as other", "import 'other.jh' as other", 2);
  assert.equal(result.path, "other.jh");
  assert.equal(result.alias, "other");
});

test("parseImportLine: fails on missing alias", () => {
  assert.throws(
    () => parseImportLine("test.jh", 'import "file.jh"', 'import "file.jh"', 1),
    /E_PARSE/,
  );
});

test("parseImportLine: fails on missing path", () => {
  assert.throws(
    () => parseImportLine("test.jh", "import as alias", "import as alias", 1),
    /E_PARSE/,
  );
});

test("parseImportLine: fails on alias starting with digit", () => {
  assert.throws(
    () => parseImportLine("test.jh", 'import "a.jh" as 1bad', 'import "a.jh" as 1bad', 1),
    /E_PARSE/,
  );
});
