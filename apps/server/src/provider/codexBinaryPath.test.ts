import { assert, it } from "@effect/vitest";

import { pickCodexDesktopCliVersionDirectory } from "./codexBinaryPath.ts";

it("picks the most recently modified Codex desktop CLI folder", () => {
  assert.strictEqual(
    pickCodexDesktopCliVersionDirectory([
      { name: "0f3a91", modifiedAtMs: 1_700_000_000_000 },
      { name: "9b21c4", modifiedAtMs: 1_700_000_300_000 },
      { name: "77cd02", modifiedAtMs: 1_700_000_100_000 },
    ]),
    "9b21c4",
  );
  assert.strictEqual(pickCodexDesktopCliVersionDirectory([]), null);
});
