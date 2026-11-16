# Backend stream fixtures

Captured-shape samples of the `claude` CLI stream run with
`claude -p --output-format stream-json --include-partial-messages`, used by
`src/runtime/kernel/stream-parser.test.ts`.

- `claude-multi-turn.jsonl` — a prompt that forces one tool call: turn 1 narrates
  ("I'll inspect the repo first.") and emits a `tool_use`; a `tool_result` comes
  back; turn 2 answers ("APPROVED"). Each assistant turn opens with a
  `stream_event` `message_start`, streams its text via `text_delta`, and the run
  ends with a terminal `result`. This is the regression case for
  [#dev] "Capture only the final answer from a multi-turn agent stream": the
  captured value must be only the last turn's text (`APPROVED`), not the
  concatenation of every turn's deltas.
- `claude-single-turn.jsonl` — one assistant turn, to pin that single-turn capture
  is unchanged.

These wire-shape samples are hand-authored to the documented `stream-json` event
shape rather than piped from a live `claude -p` run, because this lane must never
launch a nested agent session. The field names mirror exactly what
`stream-parser.ts` reads (`stream_event` / `message_start` / `content_block_delta`
/ `text_delta`, `assistant` / `message.content`, and the terminal `result`).
