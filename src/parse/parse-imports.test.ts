import test from "node:test";
import assert from "node:assert/strict";
import { parseImportLine, parseScriptImportLine } from "./imports";

test("parseImportLine: parses valid double-quoted import", () => {
  const result = parseImportLine("test.jh", 'import "tools.jh" as tools', 'import "tools.jh" as tools', 1);
  assert.equal(result.path, "tools.jh");
  assert.equal(result.alias, "tools");
  assert.equal(result.loc.line, 1);
});

test("parseImportLine: rejects single-quoted import path", () => {
  assert.throws(
    () => parseImportLine("test.jh", "import 'other.jh' as other", "import 'other.jh' as other", 2),
    /single-quoted strings are not supported/,
  );
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

// === import script ===

test("parseScriptImportLine: parses valid script import", () => {
  const raw = 'import script "./queue.py" as queue';
  const result = parseScriptImportLine("test.jh", raw, raw, 1);
  assert.equal(result.path, "./queue.py");
  assert.equal(result.alias, "queue");
  assert.equal(result.loc.line, 1);
});

test("parseScriptImportLine: rejects single-quoted path", () => {
  assert.throws(
    () => parseScriptImportLine("test.jh", "import script './q.py' as q", "import script './q.py' as q", 1),
    /single-quoted strings are not supported/,
  );
});

test("parseScriptImportLine: fails on missing alias", () => {
  assert.throws(
    () => parseScriptImportLine("test.jh", 'import script "./q.py"', 'import script "./q.py"', 1),
    /E_PARSE/,
  );
});

test("parseScriptImportLine: fails on alias starting with digit", () => {
  assert.throws(
    () => parseScriptImportLine("test.jh", 'import script "./q.py" as 1bad', 'import script "./q.py" as 1bad', 1),
    /E_PARSE/,
  );
});
