import type { MemThreadPriority } from "@t3tools/contracts";

/**
 * Autonomous mode's pure decisions: what the next round asks for, how long a usage limit or the
 * spending cap holds a thread, and which threads go first. See
 * docs/superpowers/specs/2026-11-16-mem-autonomous-mode-design.md.
 */

/** Accepted rounds the next one is told about, so it neither repeats nor undoes them. */
export const MEM_ROUND_MEMORY = 10;
/** Waiting after a limit's stated reset, so the provider has really reset when Mem retries. */
export const MEM_USAGE_RESET_SLACK_MS = 2 * 60_000;
/** Retry interval when a limit or the cap gives no reset time. */
export const MEM_AUTONOMOUS_RETRY_MS = 30 * 60_000;
/** A usage window this full serves only the highest-priority threads. */
const MEM_NEAR_LIMIT_PERCENT = 90;
/** Commit-hook failures sent back before Mem escalates the thread to the owner. */
export const MEM_MAX_COMMIT_FAILURES = 5;
/** Delivered rounds in a row that produced nothing before Mem stops and hands it to the owner. */
export const MEM_MAX_FAILED_ROUNDS = 2;
/** Wait before resending a round whose run produced nothing. */
export const MEM_FAILED_ROUND_BACKOFF_MS = 10 * 60_000;
const SUMMARY_MAX_LENGTH = 120;

export interface MemUsageWindow {
  readonly usedPercent: number;
  readonly resetsAtMs: number | null;
}

export interface MemThreadUsage {
  /** The thread's last run failed on a usage limit. */
  readonly limited: boolean;
  readonly windows: ReadonlyArray<MemUsageWindow>;
  /** When that limit resets, from the provider or limit recovery's estimate; null if unknown. */
  readonly limitResetAtMs?: number | null;
}

export const PRIORITY_RANK: Record<MemThreadPriority, number> = { high: 0, normal: 1, low: 2 };

export const CONTINUE_AFTER_LIMIT_INSTRUCTION =
  "The usage limit has reset. Continue exactly where you stopped.";

export const improvementInstruction = (summaries: ReadonlyArray<string>): string =>
  [
    "Find the single most valuable improvement to how this app looks or works, the way its owner would want it.",
    "Make it one small, reviewable change. Check it works: run the tests and typecheck, and look at it if it's UI.",
    "End your reply with one line starting with `Improved:` that says what you improved.",
    "Don't push, tag, release, or change anything outside this project. Mem commits for you.",
    ...(summaries.length === 0
      ? []
      : [
          "",
          "Don't repeat or undo these recent rounds:",
          ...summaries.map((summary) => `- ${summary}`),
        ]),
  ].join("\n");

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

const clip = (text: string) =>
  text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : text;

/** The agent's own `Improved:` line, else its closing line, else the review's reasoning. */
export const roundSummary = (evidence: string, reviewReasoning: string | null): string => {
  const improved = evidence
    .split("\n")
    .map((line) => line.trim().replace(/^[*_`]+|[*_`]+$/g, ""))
    .findLast((line) => /^improved:/i.test(line));
  if (improved !== undefined) {
    const text = improved.replace(/^improved:\s*/i, "").trim();
    if (text !== "") return clip(text);
  }
  // No Improved line: the agent's own closing line still says what it did, better than the review.
  const closing = evidence
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "");
  if (closing !== undefined) return clip(closing);
  const reasoning = firstLine(reviewReasoning ?? "");
  return reasoning === "" ? "Change with no summary" : clip(reasoning);
};

/**
 * When a thread out of usage may try again, or null when it isn't out of usage. A full window
 * blocks until its reset; a failed run with no full window known retries on the plain interval.
 */
export const usageWaitUntil = (usage: MemThreadUsage, nowMs: number): number | null => {
  const full = usage.windows.filter((window) => window.usedPercent >= 100);
  if (full.length === 0 && !usage.limited) return null;
  const resets = full
    .map((window) => window.resetsAtMs)
    .filter((resetsAtMs): resetsAtMs is number => resetsAtMs !== null && resetsAtMs > nowMs);
  // Every full window has to reset before a turn can run, so the latest reset decides.
  if (resets.length > 0 && resets.length === full.length) {
    return Math.max(...resets) + MEM_USAGE_RESET_SLACK_MS;
  }
  // No full window: the failure's own reset is when limit recovery resumes the session.
  const failureReset = usage.limitResetAtMs ?? null;
  if (full.length === 0 && failureReset !== null && failureReset > nowMs) {
    return failureReset + MEM_USAGE_RESET_SLACK_MS;
  }
  return nowMs + MEM_AUTONOMOUS_RETRY_MS;
};

export const nearUsageLimit = (usage: MemThreadUsage): boolean =>
  usage.windows.some((window) => window.usedPercent >= MEM_NEAR_LIMIT_PERCENT);

/** Highest priority first; equal priorities keep their order. */
export const byPriority = <T>(
  items: ReadonlyArray<T>,
  priorityOf: (item: T) => MemThreadPriority,
): ReadonlyArray<T> =>
  items
    .map((item, index) => ({ item, index, rank: PRIORITY_RANK[priorityOf(item)] }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item);
