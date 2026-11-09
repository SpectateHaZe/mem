import { assert, describe, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

const armedThread = (
  failedAgoMs: number,
  resetAgoMs: number,
  overrides: Partial<ProjectionStore.ProjectionLimitRecoveryCandidate> = {},
): ProjectionStore.ProjectionLimitRecoveryCandidate => {
  const thread = failedThread(failedAgoMs, resetAgoMs);
  return {
    ...thread,
    ...overrides,
    limitRecovery: overrides.limitRecovery ?? {
      runId: thread.latestRunId ?? RunId.make("run:limited"),
      resetAt: thread.usageLimitResetAt ?? "",
      autoResume: true,
    },
  };
};

describe("limitRecoveryCommand firing", () => {
  it("fires one continue message once the reset passes", () => {
    const command = limitRecoveryCommand(armedThread(6 * HOUR_MS, HOUR_MS), true, nowMs);
    assert.equal(command?.type, "message.dispatch");
    assert.isTrue(
      command?.type === "message.dispatch" &&
        command.text === "Continue where you left off." &&
        command.createdBy === "agent" &&
        command.creationSource === "server" &&
        command.usageLimitContinuationOfRunId === RunId.make("run:limited"),
    );
    // The identity is deterministic, so the command receipt dedupes a
    // re-delivered sweep decision to exactly one resume per failure.
    const repeat = limitRecoveryCommand(armedThread(6 * HOUR_MS, HOUR_MS), true, nowMs);
    assert(
      repeat?.type === "message.dispatch" &&
        command?.type === "message.dispatch" &&
        repeat.commandId === command.commandId &&
        repeat.messageId === command.messageId,
    );
  });

  it("does not fire when the setting was turned off after arming", () => {
    const thread = armedThread(6 * HOUR_MS, HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, false, nowMs));
    assert.isNull(limitRecoveryCommand(thread, false, nowMs, true));
  });

  it("does not fire a reset that expired while the server was closed for over a day", () => {
    const thread = armedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });

  it("fires a reset that expired exactly 24 hours ago", () => {
    const command = limitRecoveryCommand(armedThread(30 * HOUR_MS, 24 * HOUR_MS), true, nowMs);
    assert.equal(command?.type, "message.dispatch");
  });

  it("does not fire a cancelled recovery", () => {
    const thread = armedThread(6 * HOUR_MS, HOUR_MS, {
      limitRecovery: {
        runId: RunId.make("run:limited"),
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - HOUR_MS)),
        autoResume: false,
      },
    });
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });

  it("does not fire a recovery that points at a different failure", () => {
    const thread = armedThread(6 * HOUR_MS, HOUR_MS, {
      limitRecovery: {
        runId: RunId.make("run:older"),
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - HOUR_MS)),
        autoResume: true,
      },
    });
    // A stale recovery re-arms against the current failure instead of firing.
    assert.equal(limitRecoveryCommand(thread, true, nowMs)?.type, "thread.metadata.update");
  });

  it("does not arm or fire a failure that is not a usage limit", () => {
    const thread = armedThread(6 * HOUR_MS, HOUR_MS, { lastErrorClass: "provider_error" });
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });

  it("does not fire an archived thread", () => {
    const thread = armedThread(6 * HOUR_MS, HOUR_MS, {
      archivedAt: DateTime.makeUnsafe(nowMs - HOUR_MS),
    });
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });

  it("does not fire while the thread is snoozed past the reset", () => {
    const thread = armedThread(6 * HOUR_MS, HOUR_MS, {
      snoozedUntil: DateTime.makeUnsafe(nowMs + HOUR_MS),
    });
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});
