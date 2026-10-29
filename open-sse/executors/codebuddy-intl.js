import { createHash } from "node:crypto";
import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // ponytail: port of luqman-v1/9router-go#335 — intl gateway now requires
  // X-Conversation-* header family or returns 11128 "conversation id missing"
  buildHeaders(credentials, stream, url, model, body) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    const sessionKey = credentials?.sessionId || this._firstUserText(body) || "";
    headers["X-Conversation-ID"] = sessionKey
      ? this._stableUUID("codebuddy-intl:" + sessionKey)
      : crypto.randomUUID();
    // Reuse the id the codebuddyHeaders hook minted so the request/conversation
    // pair stays identical upstream expects (a mismatch trips channel verification).
    headers["X-Conversation-Request-ID"] = headers["X-Request-ID"] || crypto.randomUUID();
    headers["X-Conversation-Message-ID"] = crypto.randomUUID();
    return headers;
  }

  /** SHA-1 → UUID v5-shaped, matches Go port's stableConversationUUID. */
  _stableUUID(key) {
    const hash = createHash("sha1").update(key).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
    hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
    const h = hash.subarray(0, 16).toString("hex");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
  }

  /** Extract first user message text for conversation-key fallback. */
  _firstUserText(body) {
    if (!body || typeof body !== "object") return "";
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    for (const m of msgs) {
      if (m?.role !== "user") continue;
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) return m.content.map(b => b?.text || "").join("\n");
      return "";
    }
    return "";
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    //
    // The gateway 400s (11128 "Illegal API invocation from an unapproved
    // channel") on exactly three Claude Code fingerprints, verified live by
    // per-line bisect of a captured request: the identity sentence, the
    // `x-anthropic-billing-header:` line, and the "(you will usually use this
    // for PRs)" parenthetical in the gitStatus block. Everything else passes
    // (agent tags, supervisor rules, 10k+ char prompts), so scrub only those
    // and keep the client's instructions — dropping the system prompt makes
    // the model ignore every client directive.
    const SYSTEM_ROLES = ["system", "developer"];
    const CLAUDE_IDENTITY = /You are Claude Code,\s+Anthropic['’]s official CLI for Claude/gi;
    const BILLING_HEADER = /^x-anthropic-billing-header:.*$/gim;
    const PR_HINT = /\s*\(you will usually use this for PRs\)/gi;
    const flatten = (content) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";

    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    const systemText = source
      .filter((m) => m && typeof m === "object" && SYSTEM_ROLES.includes(m.role))
      .map((m) => flatten(m.content))
      .filter(Boolean)
      .join("\n\n")
      .replace(BILLING_HEADER, "")
      .replace(PR_HINT, "")
      .replace(CLAUDE_IDENTITY, "You are CodeBuddy Code")
      .trim();

    transformed.messages = [{ role: "system", content: systemText || "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || SYSTEM_ROLES.includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
