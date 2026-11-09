import { CommandId, UsageDay } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { currentHit, spendingCapHit } from "./SpendingCapState.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const CHECK_INTERVAL_MS = 60_000;
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

const makeSweep = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
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
    const summary = yield* usage.readSummary({ sinceDay: day, untilDay: day, timeZone });
    const spentUsd = summary.buckets.reduce((total, bucket) => total + bucket.costUsd, 0);
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
