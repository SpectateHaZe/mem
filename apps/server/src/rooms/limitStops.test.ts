import { assert, it } from "@effect/vitest";
import { NodeId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { readLimitStop } from "./limitStops.ts";

const threadId = ThreadId.make("thread:goal");
const at = DateTime.makeUnsafe("2026-11-18T02:00:00.000Z");
const run = {
  id: RunId.make("run:1"),
  ordinal: 1,
  status: "failed",
  rootNodeId: NodeId.make("node:root"),
  completedAt: at,
} as never;

const projections = (failureClass: "usage_limit" | "provider_error") =>
  ({
    getThreadRecords: () =>
      Effect.succeed({
        runs: [run],
        turnItems: [
          {
            type: "error",
            status: "failed",
            id: "item:1",
            ordinal: 1,
            runId: RunId.make("run:1"),
            nodeId: NodeId.make("node:root"),
            updatedAt: at,
            failure: { class: failureClass, message: "stopped", code: null, retryable: null },
          },
        ],
      }),
  }) as never;

const settings = (autonomous: boolean, autoResumeLimitedThreads = false) => ({
  getSettings: Effect.succeed({ autoResumeLimitedThreads, mem: { autonomous } } as never),
});

it.effect("a limit stop resumes on its own in autonomous mode or with auto-resume on", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* readLimitStop(projections("usage_limit"), settings(true), threadId, run),
      "resumes",
    );
    assert.equal(
      yield* readLimitStop(projections("usage_limit"), settings(false, true), threadId, run),
      "resumes",
    );
    assert.equal(
      yield* readLimitStop(projections("usage_limit"), settings(false), threadId, run),
      "waits",
    );
  }),
);

it.effect("any other failure is not a limit stop", () =>
  Effect.gen(function* () {
    assert.isNull(
      yield* readLimitStop(projections("provider_error"), settings(true), threadId, run),
    );
  }),
);
