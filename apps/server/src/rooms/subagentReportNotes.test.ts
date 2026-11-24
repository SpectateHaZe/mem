import { assert, it } from "@effect/vitest";

import { subagentFinishedNote } from "./subagentReportNotes.ts";

it("reports a subagent's outcome to its parent", () => {
  assert.strictEqual(
    subagentFinishedNote("Haiku", "completed", " Done. "),
    "Subagent (Haiku) finished.\n\nDone.",
  );
  assert.strictEqual(
    subagentFinishedNote("Haiku", "failed", ""),
    "Subagent (Haiku) stopped early (failed). It left no reply.",
  );
  const long = subagentFinishedNote("Haiku", "completed", "x".repeat(30_000));
  assert.include(long, "Result cut off");
  assert.isBelow(long.length, 20_200);
});
