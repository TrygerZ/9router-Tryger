import { describe, it, expect } from "vitest";
import { getWebLoginConfig } from "open-sse/services/webLoginConfig.js";
import { extractUserToken } from "open-sse/executors/deepseek-web.js";

// chat.deepseek.com writes the SAME `userToken` key while signed out, holding a
// placeholder {"value":null,"__version":"0"}. A capture that treats any
// parseable value as a token ends the login on the first poll and closes the
// window before the user can type anything — then the identity probe rejects
// the placeholder with "userToken is invalid or expired".
const cfg = getWebLoginConfig("deepseek-web");
const validate = cfg.validateToken;

const SIGNED_OUT = '{"value":null,"__version":"0"}';
const TOKEN = "a".repeat(64);
const WRAPPED = JSON.stringify({ value: TOKEN, __version: "0" });

describe("deepseek-web login capture", () => {
  it("rejects the signed-out placeholder the site writes before login", () => {
    expect(validate(SIGNED_OUT)).toBe(false);
  });

  it("rejects an empty or whitespace value", () => {
    expect(validate("")).toBe(false);
    expect(validate("   ")).toBe(false);
    expect(validate(null)).toBe(false);
  });

  it("accepts a bare token", () => {
    expect(validate(TOKEN)).toBe(true);
  });

  it("accepts the JSON-wrapped token the site writes after login", () => {
    expect(validate(WRAPPED)).toBe(true);
  });

  it("rejects a wrapped value that is not a string", () => {
    expect(validate('{"value":123,"__version":"0"}')).toBe(false);
    expect(validate('{"value":null}')).toBe(false);
  });

  it("round-trips: a captured placeholder yields no credential", () => {
    expect(extractUserToken({ apiKey: SIGNED_OUT })).toBeNull();
  });

  it("round-trips: a captured real token yields the raw token", () => {
    expect(extractUserToken({ apiKey: WRAPPED })).toBe(TOKEN);
  });
});
