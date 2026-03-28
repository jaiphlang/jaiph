// Stream JSON parser: converts streaming backend output (cursor-agent / claude CLI)
// into sectioned text (Reasoning + Final answer) and extracts the final response.
// Port of the inline Node.js in jaiph::stream_json_to_text (now in jaiph_stdlib.sh).

import { createInterface, type Interface } from "node:readline";
import { writeFileSync } from "node:fs";
import type { Readable } from "node:stream";

export type StreamState = {
  reasoning: string;
  final: string;
  fallback: string;
  wroteAnySection: boolean;
  wroteReasoningHeader: boolean;
  wroteFinalHeader: boolean;
  sawFinalStreamDelta: boolean;
  sawFinalMessage: boolean;
  sawVisibleFinalText: boolean;
};

export function createStreamState(): StreamState {
  return {
    reasoning: "",
    final: "",
    fallback: "",
    wroteAnySection: false,
    wroteReasoningHeader: false,
    wroteFinalHeader: false,
    sawFinalStreamDelta: false,
    sawFinalMessage: false,
    sawVisibleFinalText: false,
  };
}

function append(base: string, value: unknown): string {
  return typeof value === "string" && value.length > 0 ? base + value : base;
}

function normalizeInitialFinalText(text: string, state: StreamState): string {
  if (typeof text !== "string" || text.length === 0) return "";
  if (state.sawVisibleFinalText) return text;
  const normalized = text.replace(/^(?:\r?\n)+/, "");
  if (normalized.length > 0) state.sawVisibleFinalText = true;
  return normalized;
}

function pickGeneric(obj: Record<string, unknown>): string {
  if (!obj || typeof obj !== "object") return "";
  const message = obj.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === "string") return message.content;
  if (typeof obj.delta === "string") return obj.delta;
  if (typeof obj.output_text === "string") return obj.output_text;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const c = obj.choices[0] as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    const d = c.delta as Record<string, unknown> | undefined;
    if (d && typeof d.content === "string") return d.content;
  }
  if (Array.isArray(obj.delta) && obj.delta.length > 0) {
    const first = obj.delta[0] as Record<string, unknown>;
    if (first && typeof first.text === "string") return first.text;
  }
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const first = obj.content[0] as Record<string, unknown>;
    if (first && typeof first.text === "string") return first.text;
  }
  return "";
}

export type StreamWriter = {
  writeReasoning: (text: string) => void;
  writeFinal: (text: string) => void;
};

function ensureSection(name: string, state: StreamState, writer: StreamWriter): void {
  if (name === "Reasoning") {
    if (!state.wroteReasoningHeader) {
      if (state.wroteAnySection) writer.writeReasoning("\n\n");
      writer.writeReasoning("Reasoning:\n");
      state.wroteAnySection = true;
      state.wroteReasoningHeader = true;
    }
    return;
  }
  if (!state.wroteFinalHeader) {
    if (state.wroteAnySection) writer.writeFinal("\n\n");
    writer.writeFinal("Final answer:\n");
    state.wroteAnySection = true;
    state.wroteFinalHeader = true;
  }
}

/** Process a single JSON line from the backend stream. */
export function processStreamLine(
  line: string,
  state: StreamState,
  writer: StreamWriter,
): void {
  if (!line.trim()) return;

  const writeReasoningDelta = (text: string): void => {
    if (typeof text !== "string" || text.length === 0) return;
    ensureSection("Reasoning", state, writer);
    writer.writeReasoning(text);
  };

  const writeFinalDelta = (text: string): void => {
    if (typeof text !== "string" || text.length === 0) return;
    ensureSection("Final answer", state, writer);
    writer.writeFinal(text);
  };

  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj && typeof obj === "object") {
      // Claude CLI stream_event envelope
      if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
        const event = obj.event as Record<string, unknown>;
        if (event.type === "content_block_delta" && event.delta && typeof event.delta === "object") {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
            state.reasoning = append(state.reasoning, delta.thinking);
            writeReasoningDelta(delta.thinking);
            return;
          }
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            const normalized = normalizeInitialFinalText(delta.text, state);
            state.sawFinalStreamDelta = true;
            state.final = append(state.final, normalized);
            writeFinalDelta(normalized);
            return;
          }
        }
      }

      // Standalone thinking block
      if (obj.type === "thinking" && typeof obj.text === "string" && obj.text.length > 0) {
        state.reasoning = append(state.reasoning, obj.text);
        writeReasoningDelta(obj.text);
        return;
      }

      // Assistant message with content array
      if (obj.type === "assistant" && obj.message && Array.isArray((obj.message as Record<string, unknown>).content)) {
        const msg = obj.message as Record<string, unknown>;
        const content = msg.content as Array<Record<string, unknown>>;
        let reasoningText = "";
        let finalText = "";
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "thinking" && typeof block.thinking === "string") {
            reasoningText = append(reasoningText, block.thinking);
            continue;
          }
          if (block.type === "text" && typeof block.text === "string") {
            finalText = append(finalText, block.text);
          }
        }
        if (reasoningText.length > 0) {
          state.reasoning = append(state.reasoning, reasoningText);
          writeReasoningDelta(reasoningText);
        }
        if (!state.sawFinalStreamDelta && finalText.length > 0) {
          const normalized = normalizeInitialFinalText(finalText, state);
          state.final = normalized;
          if (!state.sawFinalMessage) {
            writeFinalDelta(normalized);
            state.sawFinalMessage = true;
          }
        }
        if (reasoningText.length > 0 || finalText.length > 0) return;
      }

      // Assistant message with string content
      if (obj.type === "assistant" && obj.message && typeof (obj.message as Record<string, unknown>).content === "string") {
        const msgContent = (obj.message as Record<string, unknown>).content as string;
        if (msgContent.length > 0 && !state.sawFinalStreamDelta) {
          const normalized = normalizeInitialFinalText(msgContent, state);
          state.final = normalized;
          if (!state.sawFinalMessage) {
            writeFinalDelta(normalized);
            state.sawFinalMessage = true;
          }
        }
        return;
      }

      // Result object
      if (obj.type === "result" && typeof obj.result === "string" && obj.result.length > 0) {
        if (!state.sawFinalStreamDelta && !state.sawFinalMessage) {
          const normalized = normalizeInitialFinalText(obj.result, state);
          state.final = normalized;
          writeFinalDelta(normalized);
          state.sawFinalMessage = true;
        }
        return;
      }
    }

    // Generic fallback extraction
    const generic = pickGeneric(obj);
    if (!state.sawFinalStreamDelta && !state.sawFinalMessage && generic.length > 0) {
      const normalized = normalizeInitialFinalText(generic, state);
      state.final = normalized;
      writeFinalDelta(normalized);
      state.sawFinalMessage = true;
    }
  } catch {
    // Non-JSON line: treat as raw fallback text
    const rawLine = normalizeInitialFinalText(`${line}\n`, state);
    state.fallback = append(state.fallback, rawLine);
    writeFinalDelta(rawLine);
  }
}

/** Get the effective final text from the stream state. */
export function effectiveFinal(state: StreamState): string {
  return state.final.length > 0 ? state.final : state.fallback;
}

/**
 * Parse a full backend stream from a readable. Writes sectioned output via writer,
 * returns the final answer text.
 */
export function parseStream(
  input: Readable,
  writer: StreamWriter,
): Promise<string> {
  return new Promise((resolve) => {
    const state = createStreamState();
    const rl: Interface = createInterface({ input, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      processStreamLine(line, state, writer);
    });

    rl.on("close", () => {
      const final = effectiveFinal(state);
      if (!state.wroteAnySection && final.length > 0) {
        writer.writeFinal(`Final answer:\n${final}`);
      }
      resolve(final);
    });
  });
}

// CLI entry point: reads stdin, writes to stdout, saves final to JAIPH_PROMPT_FINAL_FILE.
if (require.main === module) {
  const writer: StreamWriter = {
    writeReasoning: (t) => { process.stdout.write(t); },
    writeFinal: (t) => { process.stdout.write(t); },
  };
  parseStream(process.stdin, writer).then((final) => {
    const finalPath = process.env.JAIPH_PROMPT_FINAL_FILE;
    if (typeof finalPath === "string" && finalPath.length > 0) {
      try { writeFileSync(finalPath, final, "utf8"); } catch { /* best-effort */ }
    }
  });
}
