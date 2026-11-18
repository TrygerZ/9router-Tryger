import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildModelGroups, collectModelValues, LIVE_CATALOG_PROVIDERS } from "@/shared/utils/selectableModels.js";

const cardSrc = fs.readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/cli-tools/components/GenericCliToolCard.js", import.meta.url),
  "utf-8"
);
const pickerSrc = fs.readFileSync(
  new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url),
  "utf-8"
);

function valuesFor({ liveModels, disabledModels = {}, isActive = true }) {
  const connection = { id: "cc-1", provider: "commandcode", isActive };
  return collectModelValues(buildModelGroups({
    connections: isActive ? [connection] : [],
    allConnections: [connection],
    modelAliases: {},
    customModels: [],
    disabledModels,
    liveModels,
  }));
}

describe("CommandCode live model pickers", () => {
  it("uses active live catalog rows instead of stale registry rows", () => {
    const values = valuesFor({
      liveModels: { commandcode: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }] },
    });

    expect(values).toContain("cmc/claude-sonnet-5-5");
    expect(values).not.toContain("cmc/deepseek/deepseek-v4-pro");
  });

  it("keeps static models when live rows are missing or empty", () => {
    for (const liveModels of [{}, { commandcode: [] }]) {
      expect(valuesFor({ liveModels })).toContain("cmc/deepseek/deepseek-v4-pro");
    }
  });

  it("does not expose live rows for an inactive connection", () => {
    const values = valuesFor({
      liveModels: { commandcode: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }] },
      isActive: false,
    });

    expect(values).not.toContain("cmc/claude-sonnet-5-5");
  });

  it("deduplicates live IDs across connections", () => {
    const values = collectModelValues(buildModelGroups({
      connections: [
        { id: "cc-1", provider: "commandcode", isActive: true },
        { id: "cc-2", provider: "commandcode", isActive: true },
      ],
      modelAliases: {},
      customModels: [],
      liveModels: {
        commandcode: [
          { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
          { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        ],
      },
    }));

    expect(values.filter((value) => value === "cmc/claude-sonnet-5-5")).toHaveLength(1);
  });

  it("filters disabled live models", () => {
    const values = valuesFor({
      liveModels: { commandcode: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }] },
      disabledModels: { cmc: ["claude-sonnet-5-5"] },
    });

    expect(values).not.toContain("cmc/claude-sonnet-5-5");
  });

  it("loads CommandCode live catalogs in both picker paths", () => {
    expect(LIVE_CATALOG_PROVIDERS).toContain("commandcode");
    expect(pickerSrc).toMatch(/LIVE_CATALOG_PROVIDERS\s*=\s*\[[^\]]*"commandcode"/s);
    expect(pickerSrc).toMatch(/commandcodeModels/);
    expect(cardSrc).toContain("buildModelGroups");
    expect(cardSrc).toMatch(/LIVE_CATALOG_PROVIDERS\.map/);
    expect(cardSrc).toContain("/api/providers/${id}/models");
    expect(cardSrc).toContain("liveModels,");
  });

  it("uses live CommandCode rows in the passthrough branch", () => {
    expect(pickerSrc).toMatch(/const providerModels = providerId === "commandcode" && commandcodeModels\.length > 0/);
    expect(pickerSrc).toMatch(/commandcodeModels\]\);/); // grouped model memo updates after the live fetch.
  });
});
