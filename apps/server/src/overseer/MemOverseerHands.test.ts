import {
  DEFAULT_MEM_OVERSEER_SETTINGS,
  MemOverseerRequestError,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type MemOverseerSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import type { MemPaceDecision } from "./MemModelPace.ts";
import {
  fingerprintEvidence,
  makeMemOverseerService,
  MEM_ESTIMATED_REVIEW_USD,
  MemOverseerFailure,
  type MemOverseerPorts,
  type MemOverseerReviewRequest,
  type MemOverseerThread,
  type MemReviewPlan,
} from "./MemOverseerService.ts";
import { newTaskRecord, type MemOverseerTaskRecord } from "./MemOverseerTaskStore.ts";
import { sumSpendInWindow, type MemSpendEntry } from "./MemSpendingCap.ts";
import type { QualityGateResult } from "./MemQualityGate.ts";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "haiku",
};

const ACCEPT: QualityGateResult = {
  verdict: "accept",
  findings: [],
  reasoning: "The evidence supports every claim.",
  nextInstruction: "Verified the parser fails closed on empty input.",
  usable: true,
};

const REJECT: QualityGateResult = {
  verdict: "reject",
  findings: ["blocking, parser.ts:12, the guard is missing"],
  reasoning: "The claim is not supported by the evidence.",
  nextInstruction: "Add the empty-input guard to parser.ts.",
  usable: true,
};

const REJECTED_INSTRUCTION = "Add the empty-input guard to parser.ts.";

const DESTRUCTIVE_INSTRUCTION = "Run rm -rf on the stale folders and delete the repository.";

const thread = (overrides: Partial<MemOverseerThread> = {}): MemOverseerThread => ({
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Fix the parser",
  idle: true,
  hasWork: true,
  task: "Fix the parser\n\nit throws on empty input",
  acceptance: "The parser fails closed on empty input.",
  root: "/repo",
  files: [{ path: "parser.ts", additions: 4, deletions: 2 }],
  evidence: "vitest: 6 passed",
  lastTurn: null,
  ...overrides,
});

const ONE_BATCH: MemReviewPlan = {
  batches: ["## parser.ts (+4/-2)\nexport const parse = () => {};"],
  deletedLines: 2,
  deletedFiles: [],
};

interface HarnessOptions {
  readonly mem?: Partial<MemOverseerSettings>;
  readonly threads?: ReadonlyArray<MemOverseerThread>;
  readonly review?: () => Effect.Effect<QualityGateResult, MemOverseerFailure>;
  readonly plan?: MemReviewPlan;
  readonly store?: Map<string, MemOverseerTaskRecord>;
  /** Ledger entries already spent, so a test can start at the cap. */
  readonly spend?: ReadonlyArray<MemSpendEntry>;
  readonly modelSelection?: ModelSelection | null;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const sent: string[] = [];
  const completed: string[] = [];
  const reviews: MemOverseerReviewRequest[] = [];
  const spawned: string[] = [];
  const lifecycles: string[] = [];
  const store = options.store ?? new Map<string, MemOverseerTaskRecord>();
  const spend = [...(options.spend ?? [])];

  const ports: MemOverseerPorts = {
    loadSettings: () => {
      const selection =
        options.modelSelection === undefined ? modelSelection : options.modelSelection;
      const pace: MemPaceDecision =
        selection === null
          ? { kind: "unset", reason: "no premium or economy model is set" }
          : {
              kind: "premium",
              selection,
              reason: "on pace (20% spent, 40% of week elapsed)",
            };
      return Effect.succeed({
        mem: { ...DEFAULT_MEM_OVERSEER_SETTINGS, enabled: true, ...options.mem },
        modelSelection: selection,
        pace,
      });
    },
    isOwnerAway: () => Effect.succeed(true),
    listThreads: () => Effect.succeed(options.threads ?? [thread()]),
    readThread: (threadId) =>
      Effect.succeed((options.threads ?? [thread()]).find((entry) => entry.threadId === threadId)),
    planReview: () => Effect.succeed(options.plan ?? ONE_BATCH),
    review: (input) => {
      reviews.push(input);
      return (options.review ?? (() => Effect.succeed(REJECT)))();
    },
    guide: (_target, instruction) => {
      sent.push(instruction);
      return Effect.void;
    },
    complete: (target) => {
      completed.push(target.threadId);
      return Effect.void;
    },
    setLifecycle: (threadId, lifecycle) => {
      lifecycles.push(`${threadId}:${lifecycle}`);
      return Effect.void;
    },
    findProjectForDirectory: () => Effect.succeed("project-1"),
    findMasterThreadId: () => Effect.undefined,
    spawnSession: (input) => {
      spawned.push(`${input.projectId}:${input.title}`);
      return Effect.succeed({ threadId: ThreadId.make("thread-spawned") });
    },
    store: {
      all: () => Effect.sync(() => [...store.values()]),
      get: (threadId) => Effect.succeed(store.get(threadId)),
      put: (record) =>
        Effect.sync(() => {
          store.set(record.task.threadId, record);
        }),
      totalSpentUsd: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((nowMs) => sumSpendInWindow({ entries: spend, nowMs })),
        ),
      recordSpend: (entry) =>
        Effect.sync(() => {
          spend.push(entry);
        }),
      approvals: () =>
        Effect.sync(() =>
          [...store.values()]
            .flatMap((record) => (record.pendingApproval === null ? [] : [record.pendingApproval]))
            .sort((left, right) => left.createdAtMs - right.createdAtMs),
        ),
    },
  };

  const service = makeMemOverseerService(ports);

  return {
    service,
    sent,
    completed,
    reviews,
    spawned,
    lifecycles,
    store,
  };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.runPromise);

const runEither = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.result, Effect.runPromise);

const refusal = (result: Result.Result<unknown, MemOverseerRequestError>) => {
  if (Result.isSuccess(result)) throw new Error("expected the request to be refused");
  return result.failure;
};

const claimedRecord = (instruction: string): MemOverseerTaskRecord => ({
  ...newTaskRecord("thread-1", 1),
  task: {
    threadId: "thread-1",
    phase: "claimed",
    rejections: 1,
    lastInstruction: instruction,
  },
});

describe("MemOverseerService.reviewThreadNow", () => {
  it("reaches the same verdict and shape a tick review would", async () => {
    const tick = makeHarness();
    await run(tick.service.tick());

    const chat = makeHarness();
    const review = await run(chat.service.reviewThreadNow("thread-1"));

    expect(review).toStrictEqual({
      verdict: "reject",
      findings: REJECT.findings,
      reasoning: REJECT.reasoning,
      nextInstruction: REJECTED_INSTRUCTION,
      accepted: false,
    });
    expect(chat.reviews).toHaveLength(1);
    // The same code and rubric, so the same recorded instruction the tick settled on.
    expect(chat.store.get("thread-1")?.task.lastInstruction).toBe(
      tick.store.get("thread-1")?.task.lastInstruction,
    );
    expect(chat.store.get("thread-1")?.task.phase).toBe("claimed");
    // A review is a model call and is charged exactly once.
    expect(chat.store.get("thread-1")?.spentUsd).toBe(MEM_ESTIMATED_REVIEW_USD);
    // Reviewing never sends: sending stays a separate, deliberate step.
    expect(chat.sent).toStrictEqual([]);
  });

  it("reports an accepting review as accepted without sending anything", async () => {
    const harness = makeHarness({ review: () => Effect.succeed(ACCEPT) });

    const review = await run(harness.service.reviewThreadNow("thread-1"));

    expect(review.accepted).toBe(true);
    expect(review.verdict).toBe("accept");
    expect(harness.sent).toStrictEqual([]);
    expect(harness.store.get("thread-1")?.task.phase).toBe("accepted");
  });

  it("refuses an id it has never seen instead of guessing a thread", async () => {
    const harness = makeHarness();

    const error = refusal(await runEither(harness.service.reviewThreadNow("thread-missing")));

    expect(error.reason).toBe("thread_not_found");
    expect(harness.reviews).toStrictEqual([]);
  });
});

describe("MemOverseerService.sendInstruction", () => {
  it("sends a harmless instruction once and holds the turn for charging", async () => {
    const harness = makeHarness();

    const result = await run(harness.service.sendInstruction("thread-1", REJECTED_INSTRUCTION));

    expect(result).toStrictEqual({ sent: true });
    expect(harness.sent).toStrictEqual([REJECTED_INSTRUCTION]);
    const record = harness.store.get("thread-1");
    expect(record?.spentUsd).toBe(0);
    expect(record?.pendingCharge).toBe(true);
    expect(record?.deliveredInstruction).toBe(REJECTED_INSTRUCTION);
    expect(record?.lastGuideSource).toBe("owner");
  });

  it("refuses to send when the cap cannot fund the turn", async () => {
    const harness = makeHarness({ mem: { spendingCapUsd: 0.1 } });

    const result = await run(harness.service.sendInstruction("thread-1", REJECTED_INSTRUCTION));

    expect(result).toStrictEqual({ sent: false, parked: "cap_reached" });
    expect(harness.sent).toStrictEqual([]);
    expect(harness.store.get("thread-1")?.task.phase).toBe("parked");
    expect(harness.store.get("thread-1")?.settledPhase).toBe("parked");
  });

  it("queues a destructive instruction as a blocking approval instead of sending it", async () => {
    const harness = makeHarness();

    const result = await run(harness.service.sendInstruction("thread-1", DESTRUCTIVE_INSTRUCTION));

    expect(result).toStrictEqual({ sent: false, parked: "approval_required" });
    expect(harness.sent).toStrictEqual([]);
    const record = harness.store.get("thread-1");
    expect(record?.pendingApproval?.instruction).toBe(DESTRUCTIVE_INSTRUCTION);
    expect(record?.pendingApproval?.blocking).toBe(true);
    expect(record?.pendingApproval?.approvalId).toBe(fingerprintEvidence(thread().evidence));
    expect(record?.spentUsd).toBe(0);
  });

  it("keeps the queued approval through a tick instead of replacing it", async () => {
    const harness = makeHarness();

    await run(harness.service.sendInstruction("thread-1", DESTRUCTIVE_INSTRUCTION));
    const queued = harness.store.get("thread-1")?.pendingApproval;

    await run(harness.service.tick());
    await run(harness.service.tick());

    expect(harness.sent).toStrictEqual([]);
    expect(harness.store.get("thread-1")?.pendingApproval).toStrictEqual(queued);
    expect(await run(harness.service.pendingApprovals())).toHaveLength(1);
  });

  it("never sends the same instruction twice", async () => {
    const harness = makeHarness();

    const first = await run(harness.service.sendInstruction("thread-1", REJECTED_INSTRUCTION));
    const second = await run(harness.service.sendInstruction("thread-1", REJECTED_INSTRUCTION));

    expect(first).toStrictEqual({ sent: true });
    expect(second).toStrictEqual({ sent: false, parked: "already_delivered" });
    expect(harness.sent).toStrictEqual([REJECTED_INSTRUCTION]);
  });

  it("does not queue the same blocking instruction twice", async () => {
    const harness = makeHarness();

    await run(harness.service.sendInstruction("thread-1", DESTRUCTIVE_INSTRUCTION));
    const queued = harness.store.get("thread-1")?.pendingApproval;
    const second = await run(harness.service.sendInstruction("thread-1", DESTRUCTIVE_INSTRUCTION));

    expect(second).toStrictEqual({ sent: false, parked: "approval_required" });
    expect(harness.store.get("thread-1")?.pendingApproval).toStrictEqual(queued);
    expect(await run(harness.service.pendingApprovals())).toHaveLength(1);
  });
});

describe("MemOverseerService.spawnSession", () => {
  it("fails cleanly when no spawn directory is configured", async () => {
    const harness = makeHarness({ mem: { spawnDirectory: "  " } });

    const error = refusal(
      await runEither(harness.service.spawnSession({ prompt: "Fix the parser", modelSelection })),
    );

    expect(error).toBeInstanceOf(MemOverseerRequestError);
    expect(error.reason).toBe("spawn_directory_empty");
    expect(harness.spawned).toStrictEqual([]);
    expect(harness.store.size).toBe(0);
  });

  it("creates a session under the configured directory and holds its first turn", async () => {
    const harness = makeHarness({ mem: { spawnDirectory: "C:/work" } });

    const spawned = await run(
      harness.service.spawnSession({ prompt: "Fix the parser", modelSelection }),
    );

    expect(spawned.threadId).toBe("thread-spawned");
    expect(harness.spawned).toStrictEqual(["project-1:Fix the parser"]);
    const record = harness.store.get("thread-spawned");
    expect(record?.spentUsd).toBe(0);
    expect(record?.pendingCharge).toBe(true);
    // The prompt is already in the thread, so the loop must not send it again.
    expect(record?.deliveredInstruction).toBe("Fix the parser");
    expect(record?.task.lastInstruction).toBeNull();
  });

  it("refuses to spawn when the cap cannot fund the first turn", async () => {
    const harness = makeHarness({ mem: { spawnDirectory: "C:/work", spendingCapUsd: 0.1 } });

    const error = refusal(
      await runEither(harness.service.spawnSession({ prompt: "Fix it", modelSelection })),
    );

    expect(error.reason).toBe("cap_reached");
    expect(harness.spawned).toStrictEqual([]);
  });
});

describe("MemOverseerService.threadState", () => {
  it("returns the last verdict without spending another call", async () => {
    const harness = makeHarness({ review: () => Effect.succeed(REJECT) });

    await run(harness.service.reviewThreadNow("thread-1"));
    const state = await run(harness.service.threadState("thread-1"));

    expect(state).toStrictEqual({
      verdict: "reject",
      reason: REJECT.reasoning,
      masterThreadId: null,
    });
    expect(harness.reviews).toHaveLength(1);
  });
});

describe("MemOverseerService.listWatched", () => {
  it("reflects the persisted task state", async () => {
    const harness = makeHarness({
      store: new Map([
        [
          "thread-1",
          {
            ...claimedRecord(REJECTED_INSTRUCTION),
            spentUsd: 0.5,
            updatedAtMs: 2,
          },
        ],
        [
          "thread-2",
          {
            ...newTaskRecord("thread-2", 1),
            task: { threadId: "thread-2", phase: "accepted", rejections: 0, lastInstruction: null },
            pendingApproval: {
              approvalId: "abc",
              threadId: "thread-2",
              projectId: "project-1",
              instruction: DESTRUCTIVE_INSTRUCTION,
              createdAtMs: 1,
              evidenceFingerprint: "abc",
              blocking: true,
            },
            updatedAtMs: 1,
          },
        ],
      ]),
    });

    const watched = await run(harness.service.listWatched());

    expect(watched).toStrictEqual([
      {
        threadId: "thread-1",
        phase: "claimed",
        rejections: 1,
        lastInstruction: REJECTED_INSTRUCTION,
        spendUsd: 0.5,
        pendingApproval: false,
      },
      {
        threadId: "thread-2",
        phase: "accepted",
        rejections: 0,
        lastInstruction: null,
        spendUsd: 0,
        pendingApproval: true,
      },
    ]);
  });
});

describe("MemOverseerService.setLifecycle", () => {
  it("dispatches the mark and reopens a settled task for a fresh review", async () => {
    const settled: MemOverseerTaskRecord = {
      ...claimedRecord(REJECTED_INSTRUCTION),
      task: { threadId: "thread-1", phase: "escalated", rejections: 3, lastInstruction: null },
      settledPhase: "escalated",
      spentUsd: 1,
    };
    const harness = makeHarness({ store: new Map([["thread-1", settled]]) });

    await run(harness.service.setLifecycle("thread-1", "in_progress"));

    expect(harness.lifecycles).toStrictEqual(["thread-1:in_progress"]);
    const record = harness.store.get("thread-1");
    expect(record?.task.phase).toBe("claimed");
    expect(record?.settledPhase).toBeNull();
    // The budget spent so far is never handed back.
    expect(record?.spentUsd).toBe(1);
  });
});

describe("MemOverseerService request budget", () => {
  it("refuses a chat review once the cap is spent", async () => {
    const nowMs = await run(Clock.currentTimeMillis);
    const harness = makeHarness({
      mem: { spendingCapUsd: 0.2 },
      spend: [{ atMs: nowMs, usd: 0.2, threadId: "thread-1" }],
      store: new Map([["thread-1", claimedRecord(REJECTED_INSTRUCTION)]]),
    });

    const error = refusal(await runEither(harness.service.reviewThreadNow("thread-1")));

    expect(error.reason).toBe("cap_reached");
    expect(harness.reviews).toStrictEqual([]);
  });
});
