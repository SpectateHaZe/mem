import type { ServerProvider, UsageProviderKind } from "@t3tools/contracts";
import { CommandId, UsageDay } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { USAGE_PROVIDER_BY_DRIVER } from "../provider/builtInDrivers.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { currentHit, lastSpentUsd, spendingCapHit } from "./SpendingCapState.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const CHECK_INTERVAL_MS = 60_000;
// Longer than any local day, so a thread used today is always included.
const SESSION_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const decodeUsageDay = Schema.decodeSync(UsageDay);

// en-CA formats as YYYY-MM-DD.
export const localUsageDay = (nowMs: number, timeZone: string) =>
  decodeUsageDay(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(nowMs),
  );

/** Auth types that bill each call rather than drawing on a subscription plan. */
const METERED_CLAUDE_AUTH_TYPES: ReadonlySet<string> = new Set([
  "apiKey",
  "bedrock",
  "customEndpoint",
]);

/** Subscription plans have no marginal cost, so they must not consume the spending cap. */
export function isSubscriptionBilledProvider(provider: ServerProvider): boolean {
  if (provider.auth.status !== "authenticated") return false;
  switch (provider.driver) {
    case "claudeAgent":
      return provider.auth.type !== undefined && !METERED_CLAUDE_AUTH_TYPES.has(provider.auth.type);
    case "codex":
      return provider.auth.subscriptionSharing === true || provider.auth.type === "chatgpt";
    case "antigravity":
      return provider.auth.type === "oauth-personal" || provider.auth.type === "oauth-business";
    default:
      return false;
  }
}

/**
 * Usage providers whose every authenticated login is subscription-billed. A metered login for the
 * same provider keeps it counted, since transcripts cannot attribute cost to a specific login.
 */
export function subscriptionUsageProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlySet<UsageProviderKind> {
  const subscription = new Set<UsageProviderKind>();
  const metered = new Set<UsageProviderKind>();
  for (const provider of providers) {
    if (provider.auth.status !== "authenticated") continue;
    const kind = USAGE_PROVIDER_BY_DRIVER.get(provider.driver);
    if (!kind) continue;
    (isSubscriptionBilledProvider(provider) ? subscription : metered).add(kind);
  }
  return new Set([...subscription].filter((kind) => !metered.has(kind)));
}

/** Estimated pay-per-use cost only; subscription plans contribute nothing to the cap. */
export function billableSpendUsd(
  buckets: ReadonlyArray<{ readonly provider: UsageProviderKind; readonly costUsd: number }>,
  subscriptionProviders: ReadonlySet<UsageProviderKind>,
): number {
  return buckets
    .filter((bucket) => !subscriptionProviders.has(bucket.provider))
    .reduce((total, bucket) => total + bucket.costUsd, 0);
}

const makeSweep = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  let lastCheckMs = 0;
  let lastCap: number | null | undefined;

  return Effect.fn("SpendingCapWorker.sweep")(function* () {
    const { dailySpendCapUsd: capUsd } = yield* settings.getSettings;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    // A raised cap has to unblock agents without waiting for the next minute.
    if (capUsd === lastCap && nowMs - lastCheckMs < CHECK_INTERVAL_MS) return;
    lastCap = capUsd;
    lastCheckMs = nowMs;
    if (capUsd === null) {
      yield* Ref.set(currentHit, undefined);
      return;
    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const day = localUsageDay(nowMs, timeZone);
    // Transcripts cover the whole machine; only sessions Mem launched count against its cap.
    const sessionIds = yield* projections.listRecentNativeSessionIds(
      DateTime.formatIso(DateTime.makeUnsafe(nowMs - SESSION_LOOKBACK_MS)),
    );
    const summary = yield* usage.readSummary({
      sinceDay: day,
      untilDay: day,
      timeZone,
      sessionIds,
    });
    const providers = yield* Effect.forEach(
      yield* providerInstances.listInstances,
      (instance) => instance.snapshot.getSnapshot,
    );
    const spentUsd = billableSpendUsd(summary.buckets, subscriptionUsageProviders(providers));
    yield* Ref.set(lastSpentUsd, spentUsd);
    const hit = spendingCapHit(spentUsd, capUsd);
    const previous = yield* Ref.getAndSet(currentHit, hit);
    if (hit === undefined || previous !== undefined) return;

    yield* Effect.logWarning("orchestration-v2.spending-cap.reached", hit);
    for (const thread of yield* projections.listActiveShellIndex()) {
      if (!thread.mayBeLive) continue;
      yield* threads
        .dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`spend-cap-stop:${thread.id}:${nowMs}`),
          threadId: thread.id,
          reason: `Daily spending cap of $${capUsd} reached.`,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.spending-cap.stop-failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("spending-cap", sweep());
  }),
);
