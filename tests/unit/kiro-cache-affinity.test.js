import { beforeEach, describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { clearKiroSessionReplayStore } from "../../open-sse/utils/kiroSessionReplay.js";
import { clearSessionStore } from "../../open-sse/utils/sessionManager.js";

describe("Kiro multi-turn prompt cache stability", () => {
  beforeEach(() => {
    clearKiroSessionReplayStore();
    clearSessionStore();
  });

  it("ensures history in turn N+1 matches turn N currentMessage byte-for-byte (Claude route)", () => {
    const credentials = {
      connectionId: "kiro-cache-test-1",
      rawHeaders: { "x-session-id": "session-multi-turn-cache" },
    };

    // Turn 1
    const turn1 = claudeToKiroRequest("claude-sonnet-4.5", {
      messages: [{ role: "user", content: "first user prompt" }],
    }, true, credentials);

    // Turn 2
    const turn2 = claudeToKiroRequest("claude-sonnet-4.5", {
      messages: [
        { role: "user", content: "first user prompt" },
        { role: "assistant", content: "first assistant response" },
        { role: "user", content: "second user prompt" },
      ],
    }, true, credentials);

    // Turn 3
    const turn3 = claudeToKiroRequest("claude-sonnet-4.5", {
      messages: [
        { role: "user", content: "first user prompt" },
        { role: "assistant", content: "first assistant response" },
        { role: "user", content: "second user prompt" },
        { role: "assistant", content: "second assistant response" },
        { role: "user", content: "third user prompt" },
      ],
    }, true, credentials);

    // Turn 2 history[0] must match Turn 1 currentMessage (frozen msg0)
    expect(turn2.conversationState.history[0].userInputMessage.content).toBe(
      turn1.conversationState.currentMessage.userInputMessage.content
    );

    // Turn 3 history[0] must match Turn 1 currentMessage
    expect(turn3.conversationState.history[0].userInputMessage.content).toBe(
      turn1.conversationState.currentMessage.userInputMessage.content
    );

    // Turn 3 history[2] (Turn 2's user prompt) must match Turn 2's currentMessage EXACTLY
    expect(turn3.conversationState.history[2].userInputMessage.content).toBe(
      turn2.conversationState.currentMessage.userInputMessage.content
    );

    // Neither Turn 2 nor Turn 3 currentMessage should be contaminated with volatile timestamps
    expect(turn2.conversationState.currentMessage.userInputMessage.content).toBe("second user prompt");
    expect(turn3.conversationState.currentMessage.userInputMessage.content).toBe("third user prompt");
  });

  it("ensures history in turn N+1 matches turn N currentMessage byte-for-byte (OpenAI route)", () => {
    const credentials = {
      connectionId: "kiro-cache-test-2",
      rawHeaders: { "x-session-id": "session-multi-turn-openai-cache" },
    };

    // Turn 1
    const turn1 = openaiToKiroRequest("claude-sonnet-4.6", {
      messages: [{ role: "user", content: "first openai prompt" }],
    }, true, credentials);

    // Turn 2
    const turn2 = openaiToKiroRequest("claude-sonnet-4.6", {
      messages: [
        { role: "user", content: "first openai prompt" },
        { role: "assistant", content: "first assistant response" },
        { role: "user", content: "second openai prompt" },
      ],
    }, true, credentials);

    // Turn 3
    const turn3 = openaiToKiroRequest("claude-sonnet-4.6", {
      messages: [
        { role: "user", content: "first openai prompt" },
        { role: "assistant", content: "first assistant response" },
        { role: "user", content: "second openai prompt" },
        { role: "assistant", content: "second assistant response" },
        { role: "user", content: "third openai prompt" },
      ],
    }, true, credentials);

    // Turn 2 history[0] matches Turn 1 currentMessage
    expect(turn2.conversationState.history[0].userInputMessage.content).toBe(
      turn1.conversationState.currentMessage.userInputMessage.content
    );

    // Turn 3 history[2] matches Turn 2 currentMessage EXACTLY
    expect(turn3.conversationState.history[2].userInputMessage.content).toBe(
      turn2.conversationState.currentMessage.userInputMessage.content
    );

    expect(turn2.conversationState.currentMessage.userInputMessage.content).toBe("second openai prompt");
    expect(turn3.conversationState.currentMessage.userInputMessage.content).toBe("third openai prompt");
  });
});
