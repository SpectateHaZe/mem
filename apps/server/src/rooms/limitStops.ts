import type { OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ServerSettings from "../serverSettings.ts";

/** How a usage limit ended a run: `resumes` when limit recovery continues it on its own. */
export type LimitStop = "resumes" | "waits" | null;

/** Whether a usage limit ended this run, and whether limit recovery will continue it. */
export const readLimitStop = Effect.fn("rooms.readLimitStop")(
  function* (
    projections: Pick<ProjectionStore.ProjectionStoreV2["Service"], "getThreadRecords">,
    settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">,
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    if (run.status !== "failed") return null;
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemRunId: run.id,
    });
    if (usageLimitBlockedRun(records.runs, records.turnItems, null)?.id !== run.id) return null;
    const current = yield* settings.getSettings;
    return (
      current.autoResumeLimitedThreads || current.mem.autonomous ? "resumes" : "waits"
    ) satisfies LimitStop;
  },
  // Unreadable records settle the run as before rather than leaving it stuck.
  (effect) => effect.pipe(Effect.orElseSucceed((): LimitStop => null)),
);
