import { describe, expect, it } from "vite-plus/test";

import {
  openCodeModelSource,
  openCodeSourceModelFields,
  planOpenCodeSourceRows,
  type ModelPickerSourceRow,
} from "./modelPickerGroups";
import { rankModelPickerSearch } from "./modelPickerSearch";

type Option = {
  slug: string;
  name: string;
  subProvider?: string;
};

const catalog: Option[] = [
  { slug: "claude-agent/opus-4-6", name: "Opus 4.6" },
  { slug: "opencode-go/glm-5.3-flash", name: "GLM-5.3 Flash", subProvider: "OpenCode Go" },
  { slug: "opencode/glm-5.3-flash", name: "GLM-5.3 Flash", subProvider: "OpenCode Zen" },
  { slug: "google/gemini-4-argon", name: "Gemini 4 Argon", subProvider: "Google" },
  { slug: "opencode-go/gemini-4-argon", name: "Gemini 4 Argon", subProvider: "OpenCode Go" },
  { slug: "opencode-go/glm-5.3", name: "GLM-5.3", subProvider: "OpenCode Go" },
  { slug: "deepseek/deepseek-v4", name: "DeepSeek V4", subProvider: "Deepseek" },
];

function rowLabels(rows: ReadonlyArray<ModelPickerSourceRow<Option>>): string[] {
  return rows.map((row) =>
    row.kind === "group" ? `group:${row.source}:${row.label}` : `model:${row.model.slug}`,
  );
}

describe("openCodeModelSource", () => {
  it("derives the source from the part of the model id before the first slash", () => {
    expect(openCodeModelSource("opencode-go/glm-5.3-flash")).toBe("opencode-go");
    expect(openCodeModelSource("opencode/glm-5.3")).toBe("opencode");
    expect(openCodeModelSource("google/gemini")).toBe("google");
  });

  it("returns null for ids without a source", () => {
    expect(openCodeModelSource("glm-5.3")).toBeNull();
    expect(openCodeModelSource("/no-source")).toBeNull();
  });
});

describe("planOpenCodeSourceRows", () => {
  it("keeps one row per id in a group and the same model across different sources", () => {
    const rows = planOpenCodeSourceRows([
      ...catalog,
      { slug: "opencode-go/glm-5.3-flash", name: "GLM-5.3 Flash", subProvider: "OpenCode Go" },
    ]);
    const slugs = rows.flatMap((row) => (row.kind === "model" ? [row.model.slug] : []));
    expect(slugs.filter((slug) => slug === "opencode-go/glm-5.3-flash")).toHaveLength(1);
    expect(slugs.filter((slug) => slug === "opencode/glm-5.3-flash")).toHaveLength(1);
    expect(rowLabels(rows)).toEqual([
      "group:opencode-go:OpenCode Go",
      "model:opencode-go/glm-5.3-flash",
      "model:opencode-go/gemini-4-argon",
      "model:opencode-go/glm-5.3",
      "group:opencode:OpenCode Zen",
      "model:opencode/glm-5.3-flash",
      "group:claude-agent:Claude-agent",
      "model:claude-agent/opus-4-6",
      "group:deepseek:Deepseek",
      "model:deepseek/deepseek-v4",
      "group:google:Google",
      "model:google/gemini-4-argon",
    ]);
  });
});

describe("search across groups", () => {
  it("matches `go glm` on OpenCode Go models and drops other sources", () => {
    const slugs = rankModelPickerSearch(catalog, "go glm", (model) => ({
      name: model.name,
      ...(model.subProvider ? { subProvider: model.subProvider } : {}),
      ...(openCodeModelSource(model.slug) ? openCodeSourceModelFields(model) : {}),
      driverKind: "opencode",
      providerDisplayName: "OpenCode",
    })).map((model) => model.slug);
    expect(slugs.slice(0, 2)).toEqual(["opencode-go/glm-5.3-flash", "opencode-go/glm-5.3"]);
    expect(slugs).toContain("google/gemini-4-argon");
  });

  it("still finds models by source name and id", () => {
    const find = (query: string) =>
      rankModelPickerSearch(catalog, query, (model) => ({
        name: model.name,
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        ...(openCodeModelSource(model.slug) ? openCodeSourceModelFields(model) : {}),
        driverKind: "opencode",
        providerDisplayName: "OpenCode",
      }))[0]?.slug;
    expect(find("zen glm")).toBe("opencode/glm-5.3-flash");
    expect(find("deepseek")).toBe("deepseek/deepseek-v4");
    expect(find("gemini-4-argon")).toBe("google/gemini-4-argon");
  });
});
