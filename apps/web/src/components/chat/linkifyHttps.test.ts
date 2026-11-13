import { describe, expect, it } from "vite-plus/test";

import { splitHttpsLinks } from "./linkifyHttps";

describe("splitHttpsLinks", () => {
  it("links https URLs and leaves sentence punctuation outside", () => {
    expect(splitHttpsLinks("Top up at https://opencode.ai/console/billing.")).toEqual([
      { text: "Top up at ", href: null, offset: 0 },
      {
        text: "https://opencode.ai/console/billing",
        href: "https://opencode.ai/console/billing",
        offset: 10,
      },
      { text: ".", href: null, offset: 45 },
    ]);
  });

  it("leaves text without https URLs whole", () => {
    expect(splitHttpsLinks("Codex is not authenticated.")).toEqual([
      { text: "Codex is not authenticated.", href: null, offset: 0 },
    ]);
  });
});
