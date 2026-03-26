import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  processStreamLine,
  createStreamState,
  effectiveFinal,
  parseStream,
  type StreamWriter,
  type StreamState,
} from "./stream-parser";

function collectWriter(): StreamWriter & { reasoning: string; final: string } {
  const buf = { reasoning: "", final: "" };
  return {
    get reasoning() { return buf.reasoning; },
    get final() { return buf.final; },
    writeReasoning: (t: string) => { buf.reasoning += t; },
    writeFinal: (t: string) => { buf.final += t; },
  };
}

describe("processStreamLine", () => {
  it("parses result object", () => {
    const state = createStreamState();
    const w = collectWriter();
    processStreamLine('{"type":"result","result":"hello"}', state, w);
    assert.equal(state.final, "hello");
    assert.equal(w.final, "Final answer:\nhello");
  });

  it("parses thinking delta", () => {
    const state = createStreamState();
    const w = collectWriter();
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    processStreamLine(line, state, w);
    assert.equal(state.reasoning, "hmm");
    assert.equal(w.reasoning, "Reasoning:\nhmm");
  });

  it("parses text delta", () => {
    const state = createStreamState();
    const w = collectWriter();
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } },
    });
    processStreamLine(line, state, w);
    assert.equal(state.final, "answer");
    assert.ok(state.sawFinalStreamDelta);
  });

  it("strips leading newlines from first final text", () => {
    const state = createStreamState();
    const w = collectWriter();
    processStreamLine('{"type":"result","result":"\\nfoo"}', state, w);
    assert.equal(state.final, "foo");
  });

  it("parses assistant message with content array", () => {
    const state = createStreamState();
    const w = collectWriter();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "response" }] },
    });
    processStreamLine(line, state, w);
    assert.equal(state.final, "response");
  });

  it("handles non-JSON fallback", () => {
    const state = createStreamState();
    const w = collectWriter();
    processStreamLine("plain text", state, w);
    assert.equal(state.fallback, "plain text\n");
  });

  it("skips empty lines", () => {
    const state = createStreamState();
    const w = collectWriter();
    processStreamLine("", state, w);
    processStreamLine("   ", state, w);
    assert.equal(state.final, "");
    assert.equal(state.fallback, "");
  });

  it("uses generic extraction for unknown object shapes", () => {
    const state = createStreamState();
    const w = collectWriter();
    processStreamLine('{"content":"generic-content"}', state, w);
    assert.equal(state.final, "generic-content");
  });
});

describe("effectiveFinal", () => {
  it("returns final when available", () => {
    const state = createStreamState();
    state.final = "answer";
    state.fallback = "fb";
    assert.equal(effectiveFinal(state), "answer");
  });

  it("falls back to fallback when final is empty", () => {
    const state = createStreamState();
    state.fallback = "fb";
    assert.equal(effectiveFinal(state), "fb");
  });
});

describe("parseStream", () => {
  it("parses a full stream and returns final", async () => {
    const lines = [
      '{"type":"result","result":"streamed-answer"}',
      "",
    ].join("\n");
    const input = Readable.from(lines);
    const w = collectWriter();
    const final = await parseStream(input, w);
    assert.equal(final, "streamed-answer");
    assert.ok(w.final.includes("streamed-answer"));
  });

  it("writes Final answer header for bare result", async () => {
    const input = Readable.from('{"type":"result","result":"bare"}\n');
    const w = collectWriter();
    await parseStream(input, w);
    assert.ok(w.final.includes("Final answer:"));
  });
});
