import type { OrchestrationV2ProviderFailure, OrchestrationV2Run, RunId } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { isCreditExhaustionFailure } from "../mcp/delegatedTaskCredit.ts";

const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 2 * 60 * 60 * 1000;

const RATE_LIMIT = /\brate[ _-]?limit|\btoo many requests\b|\b429\b|\busage limit\b/i;

/** How many automatic limit resumes in a row led to this run; each one doubles the next wait. */
export function limitResumeStreak(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "usageLimitContinuationOfRunId">>,
  runId: RunId,
): number {
  const byId = new Map(runs.map((run) => [run.id, run]));
  let streak = 0;
  let current = byId.get(runId);
  // Each continuation points at an earlier run; the bound guards a corrupt cycle.
  while (current?.usageLimitContinuationOfRunId !== undefined && streak < 32) {
    streak += 1;
    current = byId.get(current.usageLimitContinuationOfRunId);
  }
  return streak;
}

/**
 * In autonomous mode a rate-limit or quota stop is treated as a usage limit, and one without a
 * provider reset time gets an estimated one, so limit recovery resumes it after a backoff.
 */
export function asAutonomousLimitFailure(
  failure: OrchestrationV2ProviderFailure,
  input: {
    readonly nowMs: number;
    readonly resumeStreak: number;
    /** A delegated child out of credit is retried on the fallback model, not resumed. */
    readonly creditHandledElsewhere: boolean;
  },
): OrchestrationV2ProviderFailure {
  const reclassifiable =
    failure.class === "provider_error" ||
    failure.class === "transport_error" ||
    failure.class === "unknown";
  const limited =
    failure.class === "usage_limit" ||
    (reclassifiable &&
      (RATE_LIMIT.test(failure.message) ||
        (!input.creditHandledElsewhere && isCreditExhaustionFailure(failure.message))));
  if (!limited) return failure;
  if (failure.resetAt != null) return { ...failure, class: "usage_limit" };
  const waitMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(input.resumeStreak, 10));
  return {
    ...failure,
    class: "usage_limit",
    resetAt: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs + waitMs)),
  };
}
