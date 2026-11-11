import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, threadLifecycleOf } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-lifecycle");

describe("thread lifecycle", () => {
  it("treats a thread written before the field existed as unmarked", () => {
    expect(threadLifecycleOf(v2ThreadShell)).toBe("none");
    expect(presentThreadShell(environmentId, v2ThreadShell).lifecycle).toBe("none");
  });

  it("normalizes an unknown or malformed mark to none", () => {
    expect(threadLifecycleOf({ lifecycle: "done" })).toBe("none");
    expect(threadLifecycleOf({ lifecycle: null })).toBe("none");
    expect(threadLifecycleOf({})).toBe("none");
  });

  it("reads each stored mark", () => {
    expect(threadLifecycleOf({ lifecycle: "in_progress" })).toBe("in_progress");
    expect(threadLifecycleOf({ lifecycle: "complete" })).toBe("complete");
    expect(threadLifecycleOf({ lifecycle: "abandoned" })).toBe("abandoned");
  });
});
