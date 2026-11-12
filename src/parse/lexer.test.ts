import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, type Token, type TokenKind } from "./lexer";

const toks = (src: string): Array<[TokenKind, string]> =>
  tokenize(src, "t.jh").map((t): [TokenKind, string] => [t.kind, t.text]);

/** Significant tokens only (no newline / comment). */
const sig = (src: string): Array<[TokenKind, string]> =>
  toks(src).filter(([k]) => k !== "newline" && k !== "comment");

function throwsAt(src: string, line: number, col: number, message: RegExp): void {
  assert.throws(
    () => tokenize(src, "t.jh"),
    (err: Error) => {
      assert.match(err.message, new RegExp(`t\\.jh:${line}:${col} E_PARSE `));
      assert.match(err.message, message);
      return true;
    },
  );
}

test("lexer: ident, number, punct, newline, comment with line and col", () => {
  const tokens: Token[] = tokenize('const x = 42 # note\nfoo(a, b)\n', "t.jh");
  assert.deepEqual(
    tokens.map((t) => [t.kind, t.text, t.line, t.col]),
    [
      ["ident", "const", 1, 1],
      ["ident", "x", 1, 7],
      ["punct", "=", 1, 9],
      ["number", "42", 1, 11],
      ["comment", "# note", 1, 14],
      ["newline", "\n", 1, 20],
      ["ident", "foo", 2, 1],
      ["punct", "(", 2, 4],
      ["ident", "a", 2, 5],
      ["punct", ",", 2, 6],
      ["ident", "b", 2, 8],
      ["punct", ")", 2, 9],
      ["newline", "\n", 2, 10],
    ],
  );
});

test("lexer: every punct, longest match first", () => {
  assert.deepEqual(
    sig("( ) { } , = . => -> == != =~ !~ | ; $ ${"),
    ["(", ")", "{", "}", ",", "=", ".", "=>", "->", "==", "!=", "=~", "!~", "|", ";", "$", "${"].map(
      (p): [TokenKind, string] => ["punct", p],
    ),
  );
});

test("lexer: keywords are idents", () => {
  assert.deepEqual(sig("def match return"), [
    ["ident", "def"],
    ["ident", "match"],
    ["ident", "return"],
  ]);
});

test("lexer: string keeps \\\" escapes, an apostrophe, and ${…} inside one token", () => {
  assert.deepEqual(sig('log "say \\"hi\\" ${name}"'), [
    ["ident", "log"],
    ["string", '"say \\"hi\\" ${name}"'],
  ]);
  assert.deepEqual(sig(`"it's"`), [["string", `"it's"`]]);
});

test("lexer: a backslash not before a quote stays in the string", () => {
  assert.deepEqual(sig('"a\\d+\\n"'), [["string", '"a\\d+\\n"']]);
});

test("lexer: triple_string runs to the closer line and keeps text after the closer", () => {
  const src = 'const x = """\n  line "one"\n  """\nprompt """\n  p\n""" returns "{ a: string }"\n';
  assert.deepEqual(sig(src), [
    ["ident", "const"],
    ["ident", "x"],
    ["punct", "="],
    ["triple_string", '"""\n  line "one"\n  """'],
    ["ident", "prompt"],
    ["triple_string", '"""\n  p\n"""'],
    ["ident", "returns"],
    ["string", '"{ a: string }"'],
  ]);
});

test("lexer: script_oneline with and without a tag (tags may hold . and -)", () => {
  assert.deepEqual(sig("script a = 'echo hi'"), [
    ["ident", "script"],
    ["ident", "a"],
    ["punct", "="],
    ["script_oneline", "'echo hi'"],
  ]);
  assert.deepEqual(sig("python3'print(1)'()"), [
    ["script_oneline", "python3'print(1)'"],
    ["punct", "("],
    ["punct", ")"],
  ]);
  assert.deepEqual(sig("python3.11'x' node-20'y' v.1-2'z'"), [
    ["script_oneline", "python3.11'x'"],
    ["script_oneline", "node-20'y'"],
    ["script_oneline", "v.1-2'z'"],
  ]);
});

test("lexer: one-line script has no escapes; the first ' closes it", () => {
  assert.deepEqual(sig("'echo \\\\' x"), [
    ["script_oneline", "'echo \\\\'"],
    ["ident", "x"],
  ]);
});

test("lexer: a tag separated from the quote by whitespace is an ident", () => {
  assert.deepEqual(sig("python3 'x'"), [
    ["ident", "python3"],
    ["script_oneline", "'x'"],
  ]);
});

test("lexer: script_fenced with and without a tag; closer line may carry call args", () => {
  const src = "script s = '''\n  echo 'hi'\n  '''\nnode.v-2'''\nconsole.log(1)\n'''(x)\n";
  assert.deepEqual(sig(src), [
    ["ident", "script"],
    ["ident", "s"],
    ["punct", "="],
    ["script_fenced", "'''\n  echo 'hi'\n  '''"],
    ["script_fenced", "node.v-2'''\nconsole.log(1)\n'''"],
    ["punct", "("],
    ["ident", "x"],
    ["punct", ")"],
  ]);
});

test("lexer: regex only in match-pattern position, after the alternation bar, and after =~ / !~", () => {
  const src = 'const y = match x {\n  /a/ | "b" | /c\\/d/ => "hit"\n  _ => "no"\n}\nif x =~ /^v/ { }\nif x !~ /z/ { }\n';
  assert.deepEqual(
    sig(src).filter(([k]) => k === "regex"),
    [
      ["regex", "/a/"],
      ["regex", "/c\\/d/"],
      ["regex", "/^v/"],
      ["regex", "/z/"],
    ],
  );
  const compact = sig('const y = match r.v { /a/ => "1", _ => "2" }').filter(([k]) => k === "regex");
  assert.deepEqual(compact, [["regex", "/a/"]]);
});

test("lexer: mock prompt { … } arms take regex patterns", () => {
  const src = 'test "t" {\n  mock prompt {\n    /hi/ => "hello"\n    _ => "d"\n  }\n}\n';
  assert.deepEqual(sig(src).filter(([k]) => k === "regex"), [["regex", "/hi/"]]);
});

test("lexer: / outside a regex position is an error", () => {
  throwsAt("const x = a / b", 1, 13, /unexpected character "\/"/);
  throwsAt('const y = match x {\n  "a" => /b/\n}', 2, 10, /unexpected character "\/"/);
});

test("lexer: ${…} outside a string is punct, ident, punct", () => {
  assert.deepEqual(sig("return ${x.y}"), [
    ["ident", "return"],
    ["punct", "${"],
    ["ident", "x"],
    ["punct", "."],
    ["ident", "y"],
    ["punct", "}"],
  ]);
});

test("lexer: backslash before a newline is a line-continuation punct", () => {
  assert.deepEqual(sig('prompt "a" \\\n  returns "{ s: string }"'), [
    ["ident", "prompt"],
    ["string", '"a"'],
    ["punct", "\\"],
    ["ident", "returns"],
    ["string", '"{ s: string }"'],
  ]);
  throwsAt("a \\ b", 1, 3, /unexpected character/);
});

test("lexer: mock script body is one raw_body token up to the closing } line", () => {
  const src = 'test "t" {\n  mock script lib.run() {\n    mkdir -p "$1"; echo it\'s\n    :\n  }\n}\n';
  const tokens = toks(src);
  const raw = tokens.filter(([k]) => k === "raw_body");
  assert.deepEqual(raw, [["raw_body", '    mkdir -p "$1"; echo it\'s\n    :\n']]);
  const after = tokens.slice(tokens.findIndex(([k]) => k === "raw_body") + 1);
  assert.deepEqual(after.slice(0, 2), [
    ["punct", "}"],
    ["newline", "\n"],
  ]);
});

test("lexer: unterminated string, triple string, scripts, and regex are E_PARSE at the opener", () => {
  throwsAt('log "ok"\n  log "open\nx', 2, 7, /unterminated string/);
  throwsAt('const x = """\n  never closed\n', 1, 11, /unterminated triple-quoted string/);
  throwsAt("script s = 'echo\n'", 1, 12, /unterminated one-line script/);
  throwsAt("script s = py3'''\nbody\n", 1, 12, /unterminated fenced script/);
  throwsAt("const y = match x {\n  /abc => \"a\"\n}", 2, 3, /unterminated regex/);
});

test("lexer: content after an opening triple quote is E_PARSE", () => {
  throwsAt('const x = """text"""', 1, 14, /opening """ must end its line/);
});

test("lexer: removed backtick forms keep their fence.ts messages", () => {
  throwsAt("script s = ```\necho\n```", 1, 12, /script bodies use triple single quotes/);
  throwsAt("script s = `echo`", 1, 12, /script one-liners use single quotes/);
});

test("start + startAt: lexes from an offset without recounting lines; positions stay absolute", () => {
  const src = 'a\nb\n  log "x"\n';
  const start = src.indexOf("log");
  const counted = tokenize(src, "t.jh", { start });
  const given = tokenize(src, "t.jh", { start, startAt: { line: 3, col: 3 } });
  assert.deepEqual(given, counted);
  assert.deepEqual(given[0], { kind: "ident", text: "log", line: 3, col: 3, offset: start });
});
