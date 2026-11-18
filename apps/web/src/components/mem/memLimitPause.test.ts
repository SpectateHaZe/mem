import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeLimitPause } from "./memLimitPause";

const nowMs = Date.parse("2026-11-18T01:00:00.000Z");
const label = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const runId = RunId.make("run:1");
const paused = (
  resetAt: string,
  latest: Record<string, unknown> = {},
  lastErrorClass = "usage_limit",
) => ({
  latestRun: { runId, status: "failed", ...latest } as never,
  runtime: { lastErrorClass } as never,
  archivedAt: null,
  limitRecovery: { runId, resetAt, autoResume: true },
});

describe("describeLimitPause", () => {
  it("names the earliest reset of the sessions that will resume", () => {
    expect(
      describeLimitPause(
        [paused("2026-11-18T05:00:00.000Z"), paused("2026-11-18T04:00:00.000Z")],
        nowMs,
        label,
      ),
    ).toBe("Paused until 04:00 (usage limit) (2 sessions), resumes automatically");
    expect(describeLimitPause([paused("2026-11-18T04:00:00.000Z")], nowMs, label)).toBe(
      "Paused until 04:00 (usage limit), resumes automatically",
    );
  });

  it("says nothing for a stop that will not resume on its own", () => {
    const off = paused("2026-11-18T04:00:00.000Z");
    expect(
      describeLimitPause(
        [
          { ...off, limitRecovery: { ...off.limitRecovery, autoResume: false } },
          paused("2026-11-18T04:00:00.000Z", {}, "provider_error"),
          paused("2026-11-18T04:00:00.000Z", { runId: RunId.make("run:2") }),
          paused("2026-11-18T04:00:00.000Z", { status: "completed" }),
          { ...off, latestRun: null },
          paused("2026-11-18T00:30:00.000Z"),
        ],
        nowMs,
        label,
      ),
    ).toBeNull();
  });
});
