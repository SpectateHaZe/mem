import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { asAutonomousLimitFailure, limitResumeStreak } from "./autonomousLimitStop.ts";

const nowMs = Date.parse("2026-11-18T01:00:00.000Z");
const base = { code: null, retryable: null } as const;
const input = { nowMs, resumeStreak: 0, creditHandledElsewhere: false };

describe("asAutonomousLimitFailure", () => {
  it("keeps the provider's own reset time", () => {
    const failure = {
      ...base,
      class: "usage_limit" as const,
      message: "You've hit your limit",
      resetAt: "2026-11-18T04:00:00.000Z",
    };
    expect(asAutonomousLimitFailure(failure, input)).toEqual(failure);
  });

  it("treats a rate limit as a usage limit and estimates when it resets", () => {
    const result = asAutonomousLimitFailure(
      { ...base, class: "provider_error", message: "429 Too Many Requests" },
      input,
    );
    expect(result.class).toBe("usage_limit");
    expect(result.resetAt).toBe("2026-11-18T01:05:00.000Z");
  });

  it("backs off longer after each resume that hit the limit again, up to two hours", () => {
    const failure = { ...base, class: "usage_limit" as const, message: "limit" };
    expect(asAutonomousLimitFailure(failure, { ...input, resumeStreak: 2 }).resetAt).toBe(
      "2026-11-18T01:20:00.000Z",
    );
    expect(asAutonomousLimitFailure(failure, { ...input, resumeStreak: 9 }).resetAt).toBe(
      "2026-11-18T03:00:00.000Z",
    );
  });

  it("leaves other failures alone", () => {
    const failure = { ...base, class: "provider_error" as const, message: "Syntax error" };
    expect(asAutonomousLimitFailure(failure, input)).toBe(failure);
    const denied = { ...base, class: "permission_error" as const, message: "rate limit" };
    expect(asAutonomousLimitFailure(denied, input)).toBe(denied);
  });

  it("leaves a delegated child's credit failure to the credit fallback", () => {
    const failure = { ...base, class: "provider_error" as const, message: "Insufficient Balance" };
    expect(asAutonomousLimitFailure(failure, { ...input, creditHandledElsewhere: true })).toBe(
      failure,
    );
    expect(asAutonomousLimitFailure(failure, input).class).toBe("usage_limit");
  });
});

describe("limitResumeStreak", () => {
  it("counts the automatic resumes that led to a run", () => {
    const runs = [
      { id: RunId.make("run:1") },
      { id: RunId.make("run:2"), usageLimitContinuationOfRunId: RunId.make("run:1") },
      { id: RunId.make("run:3"), usageLimitContinuationOfRunId: RunId.make("run:2") },
    ];
    expect(limitResumeStreak(runs, RunId.make("run:3"))).toBe(2);
    expect(limitResumeStreak(runs, RunId.make("run:1"))).toBe(0);
  });
});
