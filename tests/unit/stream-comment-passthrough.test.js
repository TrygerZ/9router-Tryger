import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// SSE comment lines (`: kiro-validation`) are the only liveness signal the Kiro
// integrity gate emits while an answer is still private. Translate mode used to
// drop every non-`data:` line, so the client held a silent 200 OK.

async function runTransform(targetFormat, sourceFormat, lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n")));
      controller.close();
    }
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(targetFormat, sourceFormat, "kiro", null, null, "test-model")
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("SSE comment passthrough in translate mode", () => {
  it("forwards comment lines verbatim", async () => {
    const body = await runTransform(FORMATS.OPENAI, FORMATS.OPENAI, [
      ": kiro-validation",
      "",
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hello" } }] })}`,
      "",
      "data: [DONE]",
      ""
    ]);

    expect(body).toContain(": kiro-validation\n");
    expect(body).toContain("hello");
  });

  it("forwards comments arriving between data lines", async () => {
    const body = await runTransform(FORMATS.OPENAI, FORMATS.OPENAI, [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "one" } }] })}`,
      "",
      ": keepalive",
      "",
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "two" } }] })}`,
      "",
      "data: [DONE]",
      ""
    ]);

    expect(body).toContain(": keepalive\n");
    expect(body).toContain("one");
    expect(body).toContain("two");
  });

  it("does not leak non-comment garbage lines", async () => {
    const body = await runTransform(FORMATS.OPENAI, FORMATS.OPENAI, [
      "<html>not sse</html>",
      "",
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "clean" } }] })}`,
      "",
      "data: [DONE]",
      ""
    ]);

    expect(body).toContain("clean");
    expect(body).not.toContain("<html>");
  });
});
