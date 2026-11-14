import { describe, expect, it } from "@effect/vitest";

import {
  parseAvailablePlugins,
  parseInstalledPlugins,
  parseMarketplaces,
} from "./ClaudePlugins.ts";

describe("Claude plugin CLI output", () => {
  it("keeps installed plugins and drops rows without an id", () => {
    expect(
      parseInstalledPlugins([
        { id: "ponytail@ponytail", version: "5.2.0", scope: "user", enabled: true },
        { id: "design@synced", scope: "synced", enabled: true },
        { version: "1.0.0" },
      ]),
    ).toEqual([
      { id: "ponytail@ponytail", version: "5.2.0", scope: "user", enabled: true },
      { id: "design@synced", scope: "synced", enabled: true },
    ]);
    expect(parseInstalledPlugins("not json")).toEqual([]);
  });

  it("reads the available catalog", () => {
    expect(
      parseAvailablePlugins([
        {
          pluginId: "a@m",
          name: "a",
          description: "Does a",
          marketplaceName: "m",
          installCount: 3,
          source: { source: "git" },
        },
        { name: "no id" },
      ]),
    ).toEqual([
      { pluginId: "a@m", name: "a", description: "Does a", marketplaceName: "m", installCount: 3 },
    ]);
  });

  it("shows where each marketplace comes from", () => {
    expect(
      parseMarketplaces([
        { name: "gh", source: "github", repo: "owner/repo" },
        { name: "git", source: "git", url: "https://example.com/m.git" },
        { name: "local", source: "directory", path: "C:\\m" },
      ]),
    ).toEqual([
      { name: "gh", origin: "owner/repo" },
      { name: "git", origin: "https://example.com/m.git" },
      { name: "local", origin: "C:\\m" },
    ]);
  });
});
