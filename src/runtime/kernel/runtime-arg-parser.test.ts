import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  BARE_IDENT_RE,
  commaArgsToInterpolated,
  interpolate,
  parseArgTokens,
  parseArgsRaw,
  parseInlineCaptureCall,
  parseInlineScriptAt,
  parseManagedArgAt,
  parsePromptSchema,
  sanitizeName,
  stripOuterQuotes,
} from "./runtime-arg-parser";

describe("sanitizeName", () => {
  it("preserves alphanumeric, _, -, .", () => {
    assert.equal(sanitizeName("abc_123.def-ghi"), "abc_123.def-ghi");
  });

  it("replaces unsafe chars with underscore", () => {
    assert.equal(sanitizeName("foo/bar baz"), "foo_bar_baz");
    assert.equal(sanitizeName("a:b@c#d"), "a_b_c_d");
  });
});

describe("interpolate", () => {
  it("substitutes ${var} from the vars map", () => {
    const vars = new Map([["name", "world"]]);
    assert.equal(interpolate("hello ${name}", vars), "hello world");
  });

  it("falls back to env when var is not in scope", () => {
    const vars = new Map<string, string>();
    assert.equal(interpolate("home=${HOME}", vars, { HOME: "/tmp" }), "home=/tmp");
  });

  it("returns empty string for missing identifiers", () => {
    assert.equal(interpolate("[${missing}]", new Map()), "[]");
  });

  it("supports ${var.field} JSON dot access", () => {
    const vars = new Map([["user", JSON.stringify({ name: "Adam", age: 30 })]]);
    assert.equal(interpolate("hi ${user.name}, age ${user.age}", vars), "hi Adam, age 30");
  });

  it("returns empty string for ${var.field} when base is not JSON", () => {
    const vars = new Map([["bad", "not-json"]]);
    assert.equal(interpolate("[${bad.field}]", vars), "[]");
  });
});

describe("parseInlineCaptureCall", () => {
  it("parses paren form: ref(args)", () => {
    assert.deepEqual(parseInlineCaptureCall("greet(x, y)"), { ref: "greet", argsRaw: "x, y" });
  });

  it("parses bareword form: ref args", () => {
    assert.deepEqual(parseInlineCaptureCall("greet x y"), { ref: "greet", argsRaw: "x y" });
  });

  it("parses ref with no args", () => {
    assert.deepEqual(parseInlineCaptureCall("greet"), { ref: "greet", argsRaw: "" });
  });

  it("supports dotted refs", () => {
    assert.deepEqual(parseInlineCaptureCall("mod.greet()"), { ref: "mod.greet", argsRaw: "" });
  });
});

describe("commaArgsToInterpolated", () => {
  it("wraps bare identifiers in ${...} and space-separates", () => {
    assert.equal(commaArgsToInterpolated("a, b, c"), "${a} ${b} ${c}");
  });

  it("leaves quoted/literal tokens intact", () => {
    assert.equal(commaArgsToInterpolated('"hello", x, 42'), '"hello" ${x} 42');
  });

  it("returns empty string for empty input", () => {
    assert.equal(commaArgsToInterpolated(""), "");
    assert.equal(commaArgsToInterpolated("   "), "");
  });
});

describe("parseArgsRaw", () => {
  it("splits on whitespace and interpolates each token", () => {
    const vars = new Map([["name", "world"]]);
    assert.deepEqual(parseArgsRaw("hello ${name} 42", vars), ["hello", "world", "42"]);
  });

  it("respects single- and double-quoted spans", () => {
    assert.deepEqual(parseArgsRaw('"hello world" foo', new Map()), ["hello world", "foo"]);
    assert.deepEqual(parseArgsRaw("'a b' c", new Map()), ["a b", "c"]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseArgsRaw("", new Map()), []);
  });
});

describe("parseInlineScriptAt", () => {
  it("parses inline-script form `body`(args)", () => {
    const result = parseInlineScriptAt("`echo hi`(arg1 arg2) rest");
    assert.ok(result);
    assert.equal(result!.body, "echo hi");
    assert.equal(result!.argsRaw, "arg1 arg2");
    // consumed includes everything up to and including the closing paren
    assert.equal(result!.consumed, "`echo hi`(arg1 arg2)".length);
  });

  it("returns null when input does not start with backtick", () => {
    assert.equal(parseInlineScriptAt("not backtick"), null);
  });

  it("returns null when paren is unbalanced", () => {
    assert.equal(parseInlineScriptAt("`body`(unclosed"), null);
  });
});

describe("parseManagedArgAt", () => {
  it("parses `run ref(args)` form (bare idents already wrapped by parseCallRef)", () => {
    const result = parseManagedArgAt("run greet(x)", 0);
    assert.ok(result);
    assert.equal(result!.token.kind, "managed");
    if (result!.token.kind === "managed") {
      assert.equal(result!.token.managedKind, "run");
      assert.equal(result!.token.ref, "greet");
      assert.equal(result!.token.argsRaw, "${x}");
    }
  });

  it("parses `ensure ref(args)` form", () => {
    const result = parseManagedArgAt("ensure check(a, b)", 0);
    assert.ok(result);
    if (result!.token.kind === "managed") {
      assert.equal(result!.token.managedKind, "ensure");
      assert.equal(result!.token.ref, "check");
      assert.equal(result!.token.argsRaw, "${a} ${b}");
    }
  });

  it("parses `run \\`body\\`(args)` as inline script", () => {
    const result = parseManagedArgAt("run `echo hi`(x)", 0);
    assert.ok(result);
    if (result!.token.kind === "managed_inline_script") {
      assert.equal(result!.token.body, "echo hi");
      assert.equal(result!.token.argsRaw, "x");
    } else {
      assert.fail(`expected managed_inline_script, got ${result!.token.kind}`);
    }
  });

  it("returns null when not a run/ensure prefix", () => {
    assert.equal(parseManagedArgAt("foo bar", 0), null);
  });
});

describe("parseArgTokens", () => {
  it("returns literal tokens for plain args", () => {
    const tokens = parseArgTokens("a b c");
    assert.equal(tokens.length, 3);
    assert.deepEqual(tokens.map((t) => t.kind), ["literal", "literal", "literal"]);
  });

  it("recognises managed run/ensure tokens within a list", () => {
    const tokens = parseArgTokens("foo run greet(x) bar");
    assert.equal(tokens.length, 3);
    assert.equal(tokens[0].kind, "literal");
    assert.equal(tokens[1].kind, "managed");
    assert.equal(tokens[2].kind, "literal");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseArgTokens(""), []);
  });
});

describe("stripOuterQuotes", () => {
  it('removes matching double quotes', () => {
    assert.equal(stripOuterQuotes('"hello"'), "hello");
  });

  it("removes matching single quotes", () => {
    assert.equal(stripOuterQuotes("'hello'"), "hello");
  });

  it("leaves unquoted strings unchanged", () => {
    assert.equal(stripOuterQuotes("hello"), "hello");
  });

  it("leaves mismatched quotes unchanged", () => {
    assert.equal(stripOuterQuotes("\"hello'"), "\"hello'");
  });
});

describe("parsePromptSchema", () => {
  it("parses a flat object schema with three types", () => {
    const fields = parsePromptSchema("{ name: string, age: number, active: boolean }");
    assert.deepEqual(fields, [
      { name: "name", type: "string" },
      { name: "age", type: "number" },
      { name: "active", type: "boolean" },
    ]);
  });

  it("returns empty array for empty schema", () => {
    assert.deepEqual(parsePromptSchema(""), []);
    assert.deepEqual(parsePromptSchema("{}"), []);
  });

  it("throws on union/array syntax", () => {
    assert.throws(() => parsePromptSchema("{ x: string | number }"));
    assert.throws(() => parsePromptSchema("{ xs: string[] }"));
  });

  it("throws on unsupported type", () => {
    assert.throws(() => parsePromptSchema("{ x: object }"));
  });

  it("throws on malformed entry", () => {
    assert.throws(() => parsePromptSchema("{ no_colon }"));
  });
});

describe("BARE_IDENT_RE", () => {
  it("matches valid identifier characters", () => {
    assert.ok(BARE_IDENT_RE.test("foo"));
    assert.ok(BARE_IDENT_RE.test("_bar"));
    assert.ok(BARE_IDENT_RE.test("a1_b2"));
  });

  it("rejects names that start with a digit or contain spaces/dashes", () => {
    assert.ok(!BARE_IDENT_RE.test("1abc"));
    assert.ok(!BARE_IDENT_RE.test("a b"));
    assert.ok(!BARE_IDENT_RE.test("a-b"));
  });
});
