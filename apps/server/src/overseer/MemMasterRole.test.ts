import { describe, expect, it } from "vite-plus/test";

import { MEM_MASTER_ROLE_INSTRUCTIONS, withMemMasterRole } from "./MemMasterThread.ts";

describe("withMemMasterRole", () => {
  it("puts Mem's coordinator role ahead of the owner's message", () => {
    const text = withMemMasterRole("work on ciel");
    expect(text.startsWith(MEM_MASTER_ROLE_INSTRUCTIONS)).toBe(true);
    expect(text.endsWith("work on ciel")).toBe(true);
  });

  it("leaves slash commands alone so the provider still recognises them", () => {
    expect(withMemMasterRole("/compact")).toBe("/compact");
    expect(withMemMasterRole("  /review the diff")).toBe("  /review the diff");
  });
});
