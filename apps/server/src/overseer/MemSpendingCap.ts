/**
 * Spending-cap arithmetic for the Mem overseer, kept pure so it can be tested without I/O. The cap
 * is a rolling day in integer cents, so float drift cannot walk the total past the line and a bad
 * provider report can never hand budget back.
 */

/** How far back the cap counts spend. Older entries stop holding budget but stay in the file. */
export const MEM_SPEND_WINDOW_MS = 24 * 60 * 60_000;

/** One thing Mem paid for. Append-only; the ledger never rewrites an amount it has recorded. */
export interface MemSpendEntry {
  readonly atMs: number;
  readonly usd: number;
  readonly threadId: string;
}

export type SpendDecision =
  | { readonly allowed: true; readonly remainingCents: number }
  | {
      readonly allowed: false;
      readonly reason: "cap_reached" | "estimate_exceeds_cap" | "cap_disabled";
      readonly remainingCents: number;
    };

export interface CapRunState {
  readonly spentUsd: number;
  readonly parkedTaskIds: ReadonlyArray<string>;
}

/** Rounds to whole cents. Non-finite input maps to 0 so a broken number reads as "spent nothing". */
export const toCents = (usd: number): number => {
  if (!Number.isFinite(usd)) return 0;
  // Binary floats put 1.005 at 100.49999999999999; stabilise before the integer step.
  return Math.round(Number((usd * 100).toFixed(6)));
};

const withinWindow = (entry: MemSpendEntry, cutoffMs: number): boolean =>
  Number.isFinite(entry.atMs) && entry.atMs > cutoffMs;

/** Spend inside the rolling window, summed in whole cents so the cap and the ledger agree. */
export const sumSpendInWindow = (input: {
  readonly entries: ReadonlyArray<MemSpendEntry>;
  readonly nowMs: number;
  readonly windowMs?: number;
}): number => {
  const cutoffMs = input.nowMs - (input.windowMs ?? MEM_SPEND_WINDOW_MS);
  let cents = 0;
  for (const entry of input.entries) {
    if (!withinWindow(entry, cutoffMs)) continue;
    cents += Math.max(0, toCents(entry.usd));
  }
  return cents / 100;
};

/** Keeps only what the cap still counts, so the persisted ledger cannot grow without a ceiling. */
export const pruneSpendEntries = (input: {
  readonly entries: ReadonlyArray<MemSpendEntry>;
  readonly nowMs: number;
  readonly windowMs?: number;
}): ReadonlyArray<MemSpendEntry> => {
  const cutoffMs = input.nowMs - (input.windowMs ?? MEM_SPEND_WINDOW_MS);
  return input.entries.filter((entry) => withinWindow(entry, cutoffMs));
};

export const decideSpend = (input: {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly estimatedNextTurnUsd: number;
}): SpendDecision => {
  const capCents = toCents(input.capUsd);
  const spentCents = Math.max(0, toCents(input.spentUsd));
  // A negative estimate is nonsense; letting it through would mint budget.
  const estimateCents = Math.max(0, toCents(input.estimatedNextTurnUsd));

  // A zero or negative cap means no budget, never "unlimited".
  if (capCents <= 0) return { allowed: false, reason: "cap_disabled", remainingCents: 0 };
  // Landing exactly on the cap consumes it, so equality is spent, not allowed.
  if (spentCents >= capCents) return { allowed: false, reason: "cap_reached", remainingCents: 0 };

  const remainingCents = capCents - spentCents;
  // Pre-flight: a turn that lands exactly on the line has consumed the cap, so it does not start.
  if (remainingCents - estimateCents <= 0) {
    return { allowed: false, reason: "estimate_exceeds_cap", remainingCents };
  }
  return { allowed: true, remainingCents: remainingCents - estimateCents };
};

export const accrueSpend = (input: {
  readonly spentUsd: number;
  readonly actualUsd: number;
}): { spentUsd: number } => {
  const spentCents = Math.max(0, toCents(input.spentUsd));
  const actualCents = toCents(input.actualUsd);
  if (actualCents <= 0) return { spentUsd: spentCents / 100 };
  return { spentUsd: (spentCents + actualCents) / 100 };
};

export const parkAtCap = (input: {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly claimedTaskIds: ReadonlyArray<string>;
}): { readonly shouldPark: boolean; readonly parkedTaskIds: ReadonlyArray<string> } => {
  const capCents = toCents(input.capUsd);
  const spentCents = Math.max(0, toCents(input.spentUsd));
  // A disabled cap has no budget to spend against, so everything claimed parks with it.
  const reached = capCents <= 0 || spentCents >= capCents;
  if (!reached) return { shouldPark: false, parkedTaskIds: [] };

  const seen = new Set<string>();
  const parkedTaskIds: string[] = [];
  for (const taskId of input.claimedTaskIds) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    parkedTaskIds.push(taskId);
  }
  return { shouldPark: true, parkedTaskIds };
};

export const describeCap = (state: {
  readonly capUsd: number;
  readonly spentUsd: number;
}): string => {
  const capCents = toCents(state.capUsd);
  const spentCents = Math.max(0, toCents(state.spentUsd));
  const spent = `$${(spentCents / 100).toFixed(2)}`;
  if (capCents <= 0) return `Mem spent ${spent} (cap disabled)`;

  // Floored so a nearly-spent cap never reads 100% before it is actually reached.
  const percent = spentCents >= capCents ? 100 : Math.floor((spentCents * 100) / capCents);
  return `Mem spent ${spent} of its $${(capCents / 100).toFixed(2)} cap (${percent}%)`;
};
