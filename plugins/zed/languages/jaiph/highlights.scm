; Jaiph syntax highlighting for Zed.
; Capture names follow Zed's highlight scopes so they map onto the active theme.

; Keywords: declarations, commands, control flow, and test-block constructs.
[
  "import" "export" "as" "config" "channel" "script" "def" "test" "use"
  "const" "run" "prompt" "log" "logerr" "logwarn" "fail" "return"
  "send" "recover" "catch"
  "if" "else" "for" "in" "match" "async" "returns" "not"
  "mock" "allow_failure" "expect_contain" "expect_not_contain" "expect_equal"
] @keyword

["true" "false"] @boolean

(comment) @comment

[
  (string)
  (triple_string)
  (backtick_string)
] @string

(regex) @string.regex

(number) @number

(operator) @operator

[
  "{" "}"
  "(" ")"
  "[" "]"
] @punctuation.bracket

; Dotted names: config keys (agent.model), qualified refs (helpers.scan).
(qualified_identifier) @property

(identifier) @variable

; Named prompt invocation / definition: the callee after `prompt` is a function.
; The grammar is flat, so `prompt` and its callee are adjacent children.
(source_file
  "prompt" .
  (identifier) @function)

; Match-arm wildcard `_`.
((identifier) @constant.builtin
  (#eq? @constant.builtin "_"))
