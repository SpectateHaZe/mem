import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Ref from "effect/Ref";

export interface SpendingCapHit {
  readonly spentUsd: number;
  readonly capUsd: number;
}

export const spendingCapHit = (spentUsd: number, capUsd: number | null) =>
  capUsd !== null && spentUsd >= capUsd ? { spentUsd, capUsd } : undefined;

export const startsWork = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.some((event) => event.type === "run.created" || event.type === "run-attempt.created");

// shortcut: one cap state per server process, so a per-project cap would need this keyed.
export const currentHit = Ref.makeUnsafe<SpendingCapHit | undefined>(undefined);
export const lastSpentUsd = Ref.makeUnsafe(0);
