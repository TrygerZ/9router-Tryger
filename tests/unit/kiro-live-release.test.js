import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args)
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");

const encoder = new TextEncoder();
const credentials = {
  accessToken: "test-token",
  providerSpecificData: { kiroToolCallRepair: true }
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const bytes = new Uint8Array(1 + nameBytes.length + 3 + valueBytes.length);
  let offset = 0;
  bytes[offset++] = nameBytes.length;
  bytes.set(nameBytes, offset);
  offset += nameBytes.length;
  bytes[offset++] = 7;
  new DataView(bytes.buffer).setUint16(offset, valueBytes.length, false);
  offset += 2;
  bytes.set(valueBytes, offset);
  return bytes;
}

function concat(chunks) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function frame(eventType, payload) {
  const headers = concat([encodeHeader(":event-type", eventType)]);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headers.byteLength + payloadBytes.byteLength + 4;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.byteLength, false);
  bytes.set(headers, 12);
  bytes.set(payloadBytes, 12 + headers.byteLength);
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
  view.setUint32(bytes.byteLength - 4, crc32(bytes.subarray(0, bytes.byteLength - 4)), false);
  return bytes;
}

function controlledResponse(frames = []) {
  let controller;
  const value = new Response(new ReadableStream({
    start(streamController) {
      controller = streamController;
      for (const item of frames) controller.enqueue(item);
    }
  }), { status: 200 });
  return {
    value,
    enqueue(item) {
      controller.enqueue(item);
    },
    close() {
      controller.close();
    }
  };
}

async function execute(overrides = {}) {
  const executor = new KiroExecutor();
  return executor.execute({
    model: "kr/claude-opus-4.8",
    body: { conversationState: { currentMessage: { userInputMessage: { content: "base", modelId: "m" } } } },
    stream: true,
    credentials,
    ...overrides
  });
}

// A body long enough to cross KIRO_SHORT_FINAL_MAX_CHARS (800).
const LONG_TEXT = "x".repeat(900);

function decodeChunk(value) {
  return new TextDecoder().decode(value);
}

beforeEach(() => {
  fetchMock.mockReset();
  delete process.env.KIRO_TOOL_CALL_REPAIR_BUFFER_MAX_BYTES;
  delete process.env.KIRO_TOOL_CALL_REPAIR_TTFT_TIMEOUT_MS;
  delete process.env.KIRO_TOOL_CALL_REPAIR_STALL_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.KIRO_TOOL_CALL_REPAIR_BUFFER_MAX_BYTES;
  delete process.env.KIRO_TOOL_CALL_REPAIR_TTFT_TIMEOUT_MS;
  delete process.env.KIRO_TOOL_CALL_REPAIR_STALL_TIMEOUT_MS;
});

describe("Kiro live release (HOLDING -> LIVE)", () => {
  it("releases held bytes before upstream EOF once past the repair threshold", async () => {
    const upstream = controlledResponse([
      frame("assistantResponseEvent", { content: LONG_TEXT })
    ]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute();
    const reader = result.response.body.getReader();

    // First read is the heartbeat; the semantic content must follow before the
    // upstream stream is closed -- this is the whole point of the release.
    const first = decodeChunk((await reader.read()).value);
    expect(first).toBe(": kiro-validation\n\n");

    const released = await Promise.race([
      reader.read().then((value) => decodeChunk(value.value)),
      new Promise((resolve) => setTimeout(() => resolve(null), 500))
    ]);
    expect(released).toContain(LONG_TEXT.slice(0, 100));

    upstream.close();
    await reader.cancel();
  });

  it("still holds short output until EOF (repair remains possible)", async () => {
    const upstream = controlledResponse([
      frame("assistantResponseEvent", { content: "short final" })
    ]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute();
    const reader = result.response.body.getReader();
    expect(decodeChunk((await reader.read()).value)).toBe(": kiro-validation\n\n");

    let settled = false;
    const semantic = reader.read().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    upstream.close();
    expect(decodeChunk((await semantic).value)).toContain("short final");
    await reader.cancel();
  });

  it("does not issue a repair retry after bytes were released", async () => {
    const upstream = controlledResponse([
      frame("assistantResponseEvent", { content: LONG_TEXT }),
      frame("metadataEvent", { stopReason: "malformed_model_output" })
    ]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute();
    upstream.close();
    const body = await result.response.text();

    // Exactly one upstream fetch: released bytes cannot be retracted, so the
    // malformed stop is reported after the content instead of retrying.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain(LONG_TEXT.slice(0, 100));
    expect(body).toContain("kiro_retryable_protocol_failure");
  });

  it("keeps repair working while the turn is still HOLDING", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(frame("assistantResponseEvent", { content: "..." }));
          controller.close();
        }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(frame("assistantResponseEvent", { content: "Recovered answer." }));
          controller.close();
        }
      }), { status: 200 }));

    const body = await (await execute()).response.text();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toContain("Recovered answer.");
    expect(body).not.toContain('"content":"..."');
  });

  it("keeps protocol validation active per frame after release", async () => {
    const corrupt = frame("assistantResponseEvent", { content: "second" });
    corrupt[corrupt.byteLength - 1] ^= 0xff;
    const upstream = controlledResponse([
      frame("assistantResponseEvent", { content: LONG_TEXT }),
      corrupt
    ]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute();
    const body = await result.response.text();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain(LONG_TEXT.slice(0, 100));
    // The corrupt frame after release is reported, not silently swallowed.
    expect(body).toContain("kiro_missing_terminal");
  });

  it("releases a held tool-call turn at EOF without a second fetch", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(frame("toolUseEvent", {
          toolUseId: "t1",
          name: "read_file",
          input: { path: "a.txt" }
        }));
        controller.close();
      }
    }), { status: 200 }));

    const body = await (await execute()).response.text();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body).toContain('"name":"read_file"');
    expect(body).toContain('"finish_reason":"tool_calls"');
  });

  it("releases short output live when liveStream is enabled on credentials", async () => {
    const upstream = controlledResponse([
      frame("assistantResponseEvent", { content: "fast live token" })
    ]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute({
      credentials: {
        accessToken: "test-token",
        providerSpecificData: { kiroLiveStream: true }
      }
    });
    const reader = result.response.body.getReader();
    expect(decodeChunk((await reader.read()).value)).toBe(": kiro-validation\n\n");

    const released = await Promise.race([
      reader.read().then((value) => decodeChunk(value.value)),
      new Promise((resolve) => setTimeout(() => resolve(null), 500))
    ]);
    expect(released).toContain("fast live token");

    upstream.close();
    await reader.cancel();
  });

  it("releases short output live when KIRO_LIVE_STREAM=true env is set", async () => {
    process.env.KIRO_LIVE_STREAM = "true";
    const upstream = controlledResponse([
      frame("assistantResponseEvent", { content: "env live token" })
    ]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute();
    const reader = result.response.body.getReader();
    expect(decodeChunk((await reader.read()).value)).toBe(": kiro-validation\n\n");

    const released = await Promise.race([
      reader.read().then((value) => decodeChunk(value.value)),
      new Promise((resolve) => setTimeout(() => resolve(null), 500))
    ]);
    expect(released).toContain("env live token");

    upstream.close();
    await reader.cancel();
    delete process.env.KIRO_LIVE_STREAM;
  });
});
