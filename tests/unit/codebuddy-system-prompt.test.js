// Regression tests: CodeBuddy executors must preserve the client's system
// prompt. Root cause (fixed 2026-10): codebuddy-intl replaced messages[0] with
// a hardcoded "You are CodeBuddy Code." and dropped every system/developer
// message, so supervisor/agent prompts never reached the model.
//
// The gateway's real constraint is narrower: the first message must be a
// system prompt, and the literal Claude Code identity phrase 400s with
// 11128 "Illegal API invocation from an unapproved channel" (verified live).
// The fix neutralizes only that phrase and keeps the rest of the prompt.
import { describe, it, expect } from "vitest";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const supervisorPrompt = `You are a supervisor agent that coordinates subagent work.
<agent-identity>supervisor</agent-identity>
<Behavior_Instructions>
1. Always delegate implementation to subagents via the Task tool.
2. Never implement code yourself.
</Behavior_Instructions>`;

const claudeBody = {
  model: "deepseek-v4.1-flash",
  max_tokens: 32000,
  system: [{ type: "text", text: supervisorPrompt }],
  messages: [{ role: "user", content: "Please fix the login bug in auth.js" }]
};

const exec = new CodeBuddyIntlExecutor();
const systemOf = (out) => out.messages[0].content;

describe("codebuddy-intl preserves the client system prompt", () => {
  it("keeps a supervisor prompt end to end (claude -> openai -> executor)", () => {
    const translated = claudeToOpenAIRequest("deepseek-v4.1-flash", claudeBody, true);
    const out = exec.transformRequest("deepseek-v4.1-flash", translated, true, {});
    expect(out.messages[0].role).toBe("system");
    expect(systemOf(out)).toContain("supervisor agent");
    expect(systemOf(out)).toContain("<Behavior_Instructions>");
  });

  it("neutralizes the Claude Code identity phrase but keeps the rest", () => {
    const out = exec.transformRequest("deepseek-v4.1-flash", {
      messages: [
        { role: "system", content: `${CLAUDE_IDENTITY}\nAlways delegate to subagents.` },
        { role: "user", content: "hi" }
      ]
    }, true, {});
    expect(systemOf(out)).not.toContain(CLAUDE_IDENTITY);
    expect(systemOf(out)).toContain("You are CodeBuddy Code");
    expect(systemOf(out)).toContain("Always delegate to subagents.");
  });

  it("scrubs the billing header line and the PR-hint parenthetical (live-verified 11128 triggers)", () => {
    const out = exec.transformRequest("deepseek-v4.1-flash", {
      messages: [
        { role: "system", content: "x-anthropic-billing-header: cc_version=2.1.187.802; cc_entrypoint=sdk-cli;" },
        { role: "system", content: "Keep me.\n\nMain branch (you will usually use this for PRs): master" },
        { role: "user", content: "hi" }
      ]
    }, true, {});
    expect(systemOf(out)).not.toContain("x-anthropic-billing-header");
    expect(systemOf(out)).not.toContain("you will usually use this for PRs");
    expect(systemOf(out)).toContain("Keep me.");
    expect(systemOf(out)).toContain("Main branch: master");
  });

  it("merges multiple system/developer messages instead of dropping them", () => {
    const out = exec.transformRequest("deepseek-v4.1-flash", {
      messages: [
        { role: "system", content: "Rule A." },
        { role: "developer", content: "Rule B." },
        { role: "user", content: "hi" }
      ]
    }, true, {});
    expect(systemOf(out)).toContain("Rule A.");
    expect(systemOf(out)).toContain("Rule B.");
    expect(out.messages.filter(m => m.role === "system")).toHaveLength(1);
  });

  it("still normalizes the wire shape (first message system, user content typed blocks)", () => {
    const out = exec.transformRequest("deepseek-v4.1-flash", {
      messages: [{ role: "user", content: "hi" }]
    }, true, {});
    expect(out.messages[0].role).toBe("system");
    expect(systemOf(out)).toBe("You are CodeBuddy Code.");
    expect(Array.isArray(out.messages[1].content)).toBe(true);
    expect(out.messages[1].content[0]).toEqual({ type: "text", text: "hi" });
  });

  it("leaves non-system messages untouched", () => {
    const out = exec.transformRequest("deepseek-v4.1-flash", {
      messages: [
        { role: "system", content: "Rules." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" }
      ]
    }, true, {});
    expect(out.messages.map(m => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

// ponytail: port of luqman-v1/9router-go#335 — X-Conversation-* headers
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("codebuddy-intl X-Conversation-* headers (PR #335 port)", () => {
  it("injects all three conversation headers", () => {
    const h = exec.buildHeaders({}, true, "https://www.codebuddy.ai/v2/chat/completions", "deepseek-v4.1-flash", {
      messages: [{ role: "user", content: "hi" }]
    });
    expect(h["X-Conversation-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-Request-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-Message-ID"]).toMatch(UUID_RE);
  });

  it("produces stable conversation ID for same session key", () => {
    const creds = { sessionId: "test-session-123" };
    const body = { messages: [{ role: "user", content: "hi" }] };
    const h1 = exec.buildHeaders(creds, true, "", "", body);
    const h2 = exec.buildHeaders(creds, true, "", "", body);
    expect(h1["X-Conversation-ID"]).toBe(h2["X-Conversation-ID"]);
    // request/message IDs are fresh each call
    expect(h1["X-Conversation-Request-ID"]).not.toBe(h2["X-Conversation-Request-ID"]);
  });

  it("falls back to first user text when no sessionId", () => {
    const body = { messages: [{ role: "user", content: "same opening" }] };
    const h1 = exec.buildHeaders({}, true, "", "", body);
    const h2 = exec.buildHeaders({}, true, "", "", body);
    expect(h1["X-Conversation-ID"]).toBe(h2["X-Conversation-ID"]);
  });
});
