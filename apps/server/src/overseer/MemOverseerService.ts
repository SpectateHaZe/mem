/**
 * The loop that drives the Mem overseer: one tick, one decision per claimed thread. World access
 * sits behind the ports below, and every failure is logged rather than thrown so a broken provider
 * cannot wedge the tick.
 */

import {
  CommandId,
  MessageId,
  isMemMasterThread,
  type MemAnswerApprovalInput,
  type MemAnswerApprovalResult,
  type MemOverseerRequestOperation,
  type MemOverseerRequestReason,
  MemOverseerRequestError,
  type MemOverseerSettings,
  type MemPendingApproval,
  type MemSendInstructionResult,
  type MemThreadLifecycle,
  type MemThreadReview,
  type MemThreadState,
  type MemWatchedThread,
  type ModelSelection,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import { elapsedShare } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Semaphore from "effect/Semaphore";

import { isDestructiveDeletion } from "./MemDestructiveChange.ts";
import { MemIdleTracker } from "./MemIdleTracker.ts";
import { chooseModel, type MemPaceDecision, type MemPaceInputs } from "./MemModelPace.ts";
import {
  buildReviewContext,
  MEM_REVIEW_MAX_BATCHES,
  partitionReviewContext,
  type MemChangedFile,
} from "./MemReviewContext.ts";
import {
  reduceTask,
  nextAction,
  startTask,
  type MemLoopAction,
  type MemTaskState,
} from "./MemOverseerLoop.ts";
import { MemReviewer } from "./MemReviewer.ts";
import {
  accrueSpend,
  decideSpend,
  describeCap,
  toCents,
  type MemSpendEntry,
} from "./MemSpendingCap.ts";
import {
  MemOverseerTaskStore,
  newTaskRecord,
  type MemOverseerTaskRecord,
  type MemPendingApprovalRecord,
} from "./MemOverseerTaskStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { QualityGateResult } from "./MemQualityGate.ts";

/** The scheduler ticks every few seconds; Mem only needs to think once a minute. */
const MEM_OVERSEER_TICK_INTERVAL_MS = 60_000;

/** Pre-flight guess for one turn. The cap is checked against this before a message is sent. */
export const MEM_ESTIMATED_TURN_USD = 0.25;

/** One review call over one batch of the change set. Eight of these still cost less than a turn. */
export const MEM_ESTIMATED_REVIEW_USD = 0.05;

/** A guide that produced no new evidence for this long is escalated instead of waiting forever. */
const MEM_GUIDE_STALL_MS = 30 * 60_000;

/** Silence is consent for a non-blocking question: it expires so a task cannot wedge on no answer. */
export const MEM_APPROVAL_TIMEOUT_MS = 120_000;

/** Bounded reads: the review sees the real change set, paged and capped by `MemReviewContext`. */
const MEM_TIMELINE_PAGE_SIZE = 200;
const MEM_TIMELINE_MAX_PAGES = 40;
const MEM_EVIDENCE_MAX_LENGTH = 4_000;

const DEFAULT_ACCEPTANCE =
  "The last request in the thread is fulfilled and the evidence in the thread supports every claim it makes.";

export interface MemOverseerThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** True only when no run, request, or background task can still produce output. */
  readonly idle: boolean;
  readonly hasWork: boolean;
  readonly task: string;
  readonly acceptance: string;
  /** Worktree or project root the review reads; null when neither could be resolved. */
  readonly root: string | null;
  /** Every file the thread touched, so the review reads code instead of a digest of it. */
  readonly files: ReadonlyArray<MemChangedFile>;
  readonly evidence: string;
  /** The newest completed provider turn, for the cost its provider actually reported. */
  readonly lastTurn: MemOverseerLastTurn | null;
}

export interface MemOverseerLastTurn {
  readonly completedAtMs: number;
  /** Null when the provider reported nothing; a subscription's zero is reported as zero. */
  readonly costUsd: number | null;
}

export interface MemOverseerSettingsSnapshot {
  readonly mem: MemOverseerSettings;
  /** Null when the pace decision found no model; the task parks instead of calling out. */
  readonly modelSelection: ModelSelection | null;
  /** Why this tick chose its model, logged when it is not the premium tier. */
  readonly pace: MemPaceDecision;
}

export interface MemOverseerReviewRequest {
  readonly template: string;
  readonly task: string;
  readonly acceptance: string;
  /** One batch of the real review context, never a summary. */
  readonly changes: string;
  readonly evidence: string;
  readonly modelSelection: ModelSelection;
}

/**
 * A verdict plus what the provider said the call cost, when it says anything. Text generation
 * reports no cost today, so the estimate is the fallback the cap uses.
 */
export type MemOverseerReviewResult = QualityGateResult & { readonly costUsd?: number };

/** The change set split into review passes, plus the measured deletions the gate reads. */
export interface MemReviewPlan {
  readonly batches: ReadonlyArray<string>;
  readonly deletedLines: number;
  readonly deletedFiles: ReadonlyArray<string>;
}

/** Structural port so the tests can pass a plain object instead of building the service layers. */
export interface MemOverseerStateStore {
  readonly all: () => Effect.Effect<ReadonlyArray<MemOverseerTaskRecord>>;
  readonly get: (threadId: string) => Effect.Effect<MemOverseerTaskRecord | undefined>;
  readonly put: (record: MemOverseerTaskRecord) => Effect.Effect<void>;
  /** Appends a real or estimated charge; the cap sums only the rolling day of them. */
  readonly recordSpend: (entry: MemSpendEntry) => Effect.Effect<void>;
  readonly totalSpentUsd: () => Effect.Effect<number>;
  readonly approvals: () => Effect.Effect<ReadonlyArray<MemPendingApprovalRecord>>;
}

/** The two ids a guide needs; a claimed thread carries both, and an approval persists them. */
export interface MemOverseerGuideTarget {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

/** One failure shape for every port, so the tick can log and continue instead of dying. */
export class MemOverseerFailure extends Schema.TaggedError<MemOverseerFailure>()(
  "MemOverseerFailure",
  {
    operation: Schema.Literals([
      "load-settings",
      "read-idle",
      "list-threads",
      "read-activity",
      "review",
      "guide",
      "complete",
      "lifecycle",
      "spawn",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The Mem overseer could not ${this.operation}: ${this.detail}`;
  }
}

export interface MemOverseerPorts {
  readonly loadSettings: () => Effect.Effect<MemOverseerSettingsSnapshot, MemOverseerFailure>;
  readonly isOwnerAway: (thresholdMinutes: number) => Effect.Effect<boolean, MemOverseerFailure>;
  readonly listThreads: () => Effect.Effect<ReadonlyArray<MemOverseerThread>, MemOverseerFailure>;
  /** One thread by id, claimed or not, so a request can look at any session the owner names. */
  readonly readThread: (
    threadId: string,
  ) => Effect.Effect<MemOverseerThread | undefined, MemOverseerFailure>;
  readonly planReview: (
    thread: MemOverseerThread,
  ) => Effect.Effect<MemReviewPlan, MemOverseerFailure>;
  readonly review: (
    input: MemOverseerReviewRequest,
  ) => Effect.Effect<MemOverseerReviewResult, MemOverseerFailure>;
  readonly guide: (
    target: MemOverseerGuideTarget,
    instruction: string,
  ) => Effect.Effect<void, MemOverseerFailure>;
  readonly complete: (thread: MemOverseerThread) => Effect.Effect<void, MemOverseerFailure>;
  readonly setLifecycle: (
    threadId: string,
    lifecycle: MemThreadLifecycle,
  ) => Effect.Effect<void, MemOverseerFailure>;
  /** The active project rooted at this directory, or none: Mem never invents a project root. */
  readonly findProjectForDirectory: (
    directory: string,
  ) => Effect.Effect<string | undefined, MemOverseerFailure>;
  /** The environment's single Mem thread, when one exists. */
  readonly findMasterThreadId: () => Effect.Effect<string | undefined, MemOverseerFailure>;
  readonly spawnSession: (
    input: MemOverseerSpawnRequest,
  ) => Effect.Effect<{ readonly threadId: ThreadId }, MemOverseerFailure>;
  readonly store: MemOverseerStateStore;
}

/** Everything a spawn needs once the setting has been read; the adapter owns the exact wiring. */
export interface MemOverseerSpawnRequest {
  readonly projectId: string;
  readonly spawnDirectory: string;
  readonly prompt: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
}

export interface MemOverseerServiceShape {
  readonly tick: () => Effect.Effect<void>;
  readonly pendingApprovals: () => Effect.Effect<ReadonlyArray<MemPendingApproval>>;
  readonly answerApproval: (
    input: MemAnswerApprovalInput,
  ) => Effect.Effect<MemAnswerApprovalResult>;
  readonly listWatched: () => Effect.Effect<
    ReadonlyArray<MemWatchedThread>,
    MemOverseerRequestError
  >;
  readonly threadState: (
    threadId: string,
  ) => Effect.Effect<MemThreadState, MemOverseerRequestError>;
  readonly reviewThreadNow: (
    threadId: string,
  ) => Effect.Effect<MemThreadReview, MemOverseerRequestError>;
  readonly sendInstruction: (
    threadId: string,
    instruction: string,
  ) => Effect.Effect<MemSendInstructionResult, MemOverseerRequestError>;
  readonly setLifecycle: (
    threadId: string,
    lifecycle: MemThreadLifecycle,
  ) => Effect.Effect<void, MemOverseerRequestError>;
  readonly spawnSession: (input: {
    readonly prompt: string;
    readonly title?: string | undefined;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<{ readonly threadId: string }, MemOverseerRequestError>;
}

/** FNV-1a over the evidence text; short enough to persist, stable across restarts. */
export const fingerprintEvidence = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

const isGuidePending = (state: MemTaskState, record: MemOverseerTaskRecord): boolean =>
  state.phase === "claimed" &&
  state.lastInstruction !== null &&
  record.deliveredInstruction !== state.lastInstruction;

const sameRecord = (
  left: MemOverseerTaskRecord | undefined,
  right: MemOverseerTaskRecord,
): boolean =>
  left !== undefined &&
  left.task.phase === right.task.phase &&
  left.task.rejections === right.task.rejections &&
  left.task.lastInstruction === right.task.lastInstruction &&
  left.spentUsd === right.spentUsd &&
  left.pendingCharge === right.pendingCharge &&
  left.deliveredInstruction === right.deliveredInstruction &&
  left.deliveredAtMs === right.deliveredAtMs &&
  left.deliveredEvidenceFingerprint === right.deliveredEvidenceFingerprint &&
  left.settledPhase === right.settledPhase &&
  left.pendingApproval?.approvalId === right.pendingApproval?.approvalId &&
  left.pendingApproval?.createdAtMs === right.pendingApproval?.createdAtMs &&
  left.lastGuideSource === right.lastGuideSource;

export const makeMemOverseerService = (ports: MemOverseerPorts): MemOverseerServiceShape => {
  const deliver = (target: MemOverseerGuideTarget, instruction: string) =>
    ports.guide(target, instruction).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Mem could not send a guide instruction.", {
          threadId: target.threadId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  /** Books what Mem paid for: the ledger keeps the cap honest, the record keeps the display. */
  const charge = Effect.fn("MemOverseerService.charge")(function* (
    record: MemOverseerTaskRecord,
    usd: number,
  ) {
    if (!Number.isFinite(usd) || toCents(usd) <= 0) return record;
    const atMs = yield* Clock.currentTimeMillis;
    yield* ports.store.recordSpend({ atMs, usd, threadId: record.task.threadId });
    return {
      ...record,
      spentUsd: accrueSpend({ spentUsd: record.spentUsd, actualUsd: usd }).spentUsd,
    };
  });

  /**
   * A guided turn is charged once its provider turn has ended. The provider's reported cost is the
   * real number; a subscription reports zero (or nothing), so the estimate is what keeps the cap
   * limiting activity there. Only the latest turn at or after delivery can be the one Mem started.
   */
  const settleTurnCharge = Effect.fn("MemOverseerService.settleTurnCharge")(function* (
    record: MemOverseerTaskRecord,
    thread: MemOverseerThread,
  ) {
    const deliveredAtMs = record.deliveredAtMs;
    const turn = thread.lastTurn;
    const reportedUsd =
      turn !== null && (deliveredAtMs === null || turn.completedAtMs >= deliveredAtMs)
        ? turn.costUsd
        : null;
    const usd = reportedUsd !== null && reportedUsd > 0 ? reportedUsd : MEM_ESTIMATED_TURN_USD;
    const settled = yield* charge({ ...record, pendingCharge: false }, usd);
    // Persisted here because several branches below return without another write, and a charge
    // that landed in the ledger must not be charged again on the next tick.
    yield* ports.store.put(settled);
    return settled;
  });

  /**
   * One permit for every action that moves a task or spends money, so a chat-driven request and a
   * tick can never interleave on the same thread. It is held per action rather than per tick, so a
   * slow review blocks another actor for one action instead of the whole sweep.
   */
  const actorLock = Semaphore.makeUnsafe(1);

  interface ReviewOutcome {
    readonly type: "reviewed" | "parked";
    readonly result: QualityGateResult | null;
    readonly reason: string;
    readonly costUsd: number;
  }

  /**
   * Every batch is a real model call, so each one is charged and the cap is checked before it.
   * A batch that cannot run at all makes the whole review unusable: Mem does not know enough to
   * accept work it could not read.
   */
  const reviewBatches = Effect.fn("MemOverseerService.reviewBatches")(function* (
    thread: MemOverseerThread,
    plan: MemReviewPlan,
    mem: MemOverseerSettings,
    modelSelection: ModelSelection,
  ): Effect.fn.Return<ReviewOutcome> {
    let spentUsd = yield* ports.store.totalSpentUsd().pipe(Effect.orElseSucceed(() => 0));
    let costUsd = 0;
    const findings: string[] = [];
    let verdict: "accept" | "reject" = "accept";
    let reasoning = "";
    let rejectInstruction: string | null = null;
    let acceptNote: string | null = null;

    const batches = plan.batches.slice(0, MEM_REVIEW_MAX_BATCHES);
    for (const batch of batches) {
      const budget = decideSpend({
        capUsd: mem.spendingCapUsd,
        spentUsd,
        estimatedNextTurnUsd: MEM_ESTIMATED_REVIEW_USD,
      });
      if (!budget.allowed) {
        return {
          type: "parked",
          result: null,
          reason: "no budget for the next review batch",
          costUsd,
        };
      }

      const result = yield* ports
        .review({
          template: mem.qualityPrompt,
          task: thread.task,
          acceptance: thread.acceptance,
          changes: batch,
          evidence: thread.evidence,
          modelSelection,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Mem's review failed; the thread needs a human.", {
              threadId: thread.threadId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
      // The call was made, so it is charged whether or not it answered. A provider that reports a
      // cost is charged that; text generation reports none, so the estimate stands in.
      const batchUsd = result?.costUsd ?? MEM_ESTIMATED_REVIEW_USD;
      spentUsd = accrueSpend({ spentUsd, actualUsd: batchUsd }).spentUsd;
      costUsd = accrueSpend({ spentUsd: costUsd, actualUsd: batchUsd }).spentUsd;

      if (result === null || !result.usable) {
        return {
          type: "reviewed",
          result: {
            verdict: "reject",
            findings: result === null ? findings : [...findings, ...result.findings],
            reasoning: result?.reasoning ?? "the review could not be completed",
            nextInstruction: null,
            usable: false,
          },
          reason: "",
          costUsd,
        };
      }

      findings.push(...result.findings);
      // The instruction that goes back to the session comes from a rejecting batch; an accepting
      // batch only supplies the one-line note for the summary.
      const instruction = result.nextInstruction?.trim() ? result.nextInstruction : null;
      if (result.verdict === "reject") {
        verdict = "reject";
        if (reasoning === "") reasoning = result.reasoning;
        if (rejectInstruction === null && instruction !== null) rejectInstruction = instruction;
      } else {
        if (reasoning === "") reasoning = result.reasoning;
        if (acceptNote === null && instruction !== null) acceptNote = instruction;
      }
    }

    return {
      type: "reviewed",
      result: {
        verdict,
        findings,
        reasoning,
        nextInstruction: verdict === "reject" ? rejectInstruction : acceptNote,
        usable: true,
      },
      reason: "",
      costUsd,
    };
  });

  const runThread = Effect.fn("MemOverseerService.runThread")(function* (
    thread: MemOverseerThread,
    mem: MemOverseerSettings,
    pace: MemPaceDecision,
    ownerAway: boolean,
  ) {
    const existing = yield* ports.store.get(thread.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Mem could not read a task's state.", {
          threadId: thread.threadId,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    let record: MemOverseerTaskRecord = existing ?? newTaskRecord(thread.threadId, nowMs);

    // A working thread, or one with nothing to review yet, is left alone until it is idle.
    if (!thread.idle || !thread.hasWork) {
      if (existing === undefined) yield* ports.store.put({ ...record, updatedAtMs: nowMs });
      return;
    }

    // The guided turn is over once the thread is idle, so its real cost can finally be booked.
    if (record.pendingCharge) {
      record = yield* settleTurnCharge(record, thread);
    }

    // Read after settling, so the just-booked turn counts against this thread's own decision.
    const { spend } = yield* spendForTurn(mem);

    // An escalated task is finished with Mem: a denial or an unusable review must not be re-asked.
    if (record.task.phase === "escalated") {
      if (record.settledPhase !== "escalated") {
        yield* ports.store.put({ ...record, settledPhase: "escalated", updatedAtMs: nowMs });
      }
      return;
    }

    // The last instruction was delivered and the session produced nothing new: wait, then escalate.
    if (
      record.task.phase === "claimed" &&
      record.deliveredInstruction !== null &&
      record.deliveredEvidenceFingerprint === fingerprintEvidence(thread.evidence)
    ) {
      const deliveredAtMs = record.deliveredAtMs ?? 0;
      if (nowMs - deliveredAtMs < MEM_GUIDE_STALL_MS) return;
      yield* Effect.logWarning(
        "Mem escalated a thread whose session never answered the instruction.",
        {
          threadId: thread.threadId,
        },
      );
      const stalled = reduceTask(record.task, {
        type: "reviewed",
        result: {
          verdict: "reject",
          findings: [],
          reasoning: "the session produced no new evidence after the instruction",
          nextInstruction: null,
          usable: false,
        },
      });
      yield* ports.store.put({
        ...record,
        task: stalled,
        settledPhase: stalled.phase,
        pendingApproval: null,
        updatedAtMs: nowMs,
      });
      return;
    }

    let state = record.task;
    if (!isGuidePending(state, record)) {
      // Idle with work means the turn ended; the reducer is the one place that decides what follows.
      state = reduceTask(state, { type: "turnEnded", status: "completed" });
    }

    const inputs = {
      threadIdle: thread.idle,
      ownerAway,
      budgetAllowsTurn: spend.allowed,
    } as const;
    let action: MemLoopAction = nextAction(state, inputs);

    // Measured deletions from this tick's review, which the destructive gate trusts over guesswork.
    let deletedLines = 0;
    let deletedFiles: ReadonlyArray<string> = [];

    if (action.type === "review") {
      if (pace.kind === "unset") {
        yield* Effect.logWarning("Mem parked a thread: no model is set to run the review.", {
          threadId: thread.threadId,
          reason: pace.reason,
        });
        state = reduceTask(state, { type: "capReached" });
      } else {
        const plan = yield* ports.planReview(thread).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Mem could not read a thread's change set.", {
              threadId: thread.threadId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        if (plan === null) {
          state = reduceTask(state, {
            type: "reviewed",
            result: {
              verdict: "reject",
              findings: [],
              reasoning: "the change set could not be read",
              nextInstruction: null,
              usable: false,
            },
          });
        } else {
          const outcome = yield* reviewBatches(thread, plan, mem, pace.selection);
          record = yield* charge(record, outcome.costUsd);
          if (outcome.type === "parked") {
            state = reduceTask(state, { type: "capReached" });
            if (record.settledPhase !== "parked") {
              record = { ...record, settledPhase: "parked", pendingApproval: null };
              const total = yield* ports.store
                .totalSpentUsd()
                .pipe(Effect.orElseSucceed(() => record.spentUsd));
              yield* Effect.logWarning("Mem parked a thread.", {
                threadId: thread.threadId,
                reason: outcome.reason,
                spend: describeCap({ capUsd: mem.spendingCapUsd, spentUsd: total }),
              });
            }
          } else if (outcome.result !== null) {
            deletedLines = plan.deletedLines;
            deletedFiles = plan.deletedFiles;
            state = reduceTask(state, { type: "reviewed", result: outcome.result });
            record = {
              ...record,
              lastReview: {
                verdict: outcome.result.verdict,
                reasoning: outcome.result.reasoning,
              },
            };
          }
        }
      }
      action = nextAction(state, inputs);
    }

    switch (action.type) {
      case "wait":
        break;
      case "guide": {
        if (record.deliveredInstruction === action.instruction) break;
        const fingerprint = fingerprintEvidence(thread.evidence);
        if (
          isDestructiveDeletion({
            instruction: action.instruction,
            evidence: thread.evidence,
            deletedLines,
            deletedFiles,
          })
        ) {
          // The one refusal: a deletion waits for a real answer and never expires on its own.
          if (
            record.pendingApproval?.evidenceFingerprint === fingerprint &&
            record.pendingApproval.instruction === action.instruction
          ) {
            break;
          }
          record = {
            ...record,
            pendingApproval: {
              approvalId: fingerprint,
              threadId: thread.threadId,
              projectId: thread.projectId,
              instruction: action.instruction,
              createdAtMs: nowMs,
              evidenceFingerprint: fingerprint,
              blocking: true,
            },
          };
          yield* Effect.logWarning("Mem blocked a destructive instruction (awaiting owner).", {
            threadId: thread.threadId,
          });
          break;
        }
        // Presence no longer gates work: Mem acts either way and only the summary says who was there.
        const delivered = yield* deliver(thread, action.instruction);
        if (delivered) {
          record = {
            ...record,
            pendingCharge: true,
            pendingApproval: null,
            deliveredInstruction: action.instruction,
            deliveredAtMs: nowMs,
            deliveredEvidenceFingerprint: fingerprint,
            lastGuideSource: ownerAway ? "auto" : "owner",
          };
          yield* Effect.logInfo("Mem guided a thread (sent).", {
            threadId: thread.threadId,
            ownerAway,
          });
        }
        break;
      }
      case "accept": {
        if (record.settledPhase === "accepted") break;
        const completed = yield* ports.complete(thread).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Mem could not mark an accepted thread complete.", {
              threadId: thread.threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (completed) {
          record = { ...record, settledPhase: "accepted" };
          const total = yield* ports.store
            .totalSpentUsd()
            .pipe(Effect.orElseSucceed(() => record.spentUsd));
          yield* Effect.logInfo("Mem accepted a thread.", {
            threadId: thread.threadId,
            rejections: state.rejections,
            spend: describeCap({ capUsd: mem.spendingCapUsd, spentUsd: total }),
          });
        }
        break;
      }
      case "park": {
        // A budget refusal is a cap event, so the task joins the parked set instead of lingering claimed.
        state = reduceTask(state, { type: "capReached" });
        if (record.settledPhase === "parked") break;
        record = { ...record, settledPhase: "parked", pendingApproval: null };
        const total = yield* ports.store
          .totalSpentUsd()
          .pipe(Effect.orElseSucceed(() => record.spentUsd));
        yield* Effect.logWarning("Mem parked a thread.", {
          threadId: thread.threadId,
          reason: action.reason,
          spend: describeCap({ capUsd: mem.spendingCapUsd, spentUsd: total }),
        });
        break;
      }
      case "escalate": {
        if (record.settledPhase === "escalated") break;
        record = { ...record, settledPhase: "escalated", pendingApproval: null };
        yield* Effect.logWarning("Mem escalated a thread.", {
          threadId: thread.threadId,
          reason: action.reason,
        });
        break;
      }
    }

    const next: MemOverseerTaskRecord = { ...record, task: state, updatedAtMs: nowMs };
    if (!sameRecord(existing, next)) yield* ports.store.put(next);
  });

  /**
   * The owner never answered, so Mem proceeds. Returns the threads it settled; the tick skips them,
   * because expiring an approval and guiding the same thread twice in one tick would double-send.
   */
  const expireApprovals = Effect.fn("MemOverseerService.expireApprovals")(function* (
    mem: MemOverseerSettings,
  ) {
    const pending = yield* ports.store
      .approvals()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mem could not read its pending approvals.", { cause }).pipe(
            Effect.as([] as ReadonlyArray<MemPendingApprovalRecord>),
          ),
        ),
      );
    const settledThreads = new Set<string>();
    if (pending.length === 0) return settledThreads;

    const nowMs = yield* Clock.currentTimeMillis;
    let spentUsd = yield* ports.store.totalSpentUsd().pipe(Effect.orElseSucceed(() => 0));

    for (const approval of pending) {
      // A destructive deletion waits for the owner indefinitely; the clock is not a consent here.
      if (approval.blocking) continue;
      if (nowMs - approval.createdAtMs < MEM_APPROVAL_TIMEOUT_MS) continue;
      const record = yield* ports.store.get(approval.threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mem could not read an unanswered task's state.", {
            threadId: approval.threadId,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
      // An answer or another tick may already have settled it; the record is the source of truth.
      if (record === undefined || record.pendingApproval?.approvalId !== approval.approvalId) {
        continue;
      }
      settledThreads.add(approval.threadId);

      const spend = decideSpend({
        capUsd: mem.spendingCapUsd,
        spentUsd,
        estimatedNextTurnUsd: MEM_ESTIMATED_TURN_USD,
      });
      if (!spend.allowed) {
        const parked = reduceTask(record.task, { type: "capReached" });
        yield* ports.store.put({
          ...record,
          task: parked,
          settledPhase: parked.phase,
          pendingApproval: null,
          updatedAtMs: nowMs,
        });
        yield* Effect.logWarning("Mem parked a thread instead of proceeding after no answer.", {
          threadId: approval.threadId,
          spend: describeCap({ capUsd: mem.spendingCapUsd, spentUsd }),
        });
        continue;
      }

      const delivered = yield* deliver(
        {
          threadId: ThreadId.make(approval.threadId),
          projectId: ProjectId.make(approval.projectId),
        },
        approval.instruction,
      );
      // A failed send keeps the approval queued for the next tick; the thread is still skipped.
      if (!delivered) continue;

      // Reservation for the next decision in this loop; the ledger is charged when the turn ends.
      spentUsd = accrueSpend({ spentUsd, actualUsd: MEM_ESTIMATED_TURN_USD }).spentUsd;
      yield* ports.store.put({
        ...record,
        pendingCharge: true,
        pendingApproval: null,
        deliveredInstruction: approval.instruction,
        deliveredAtMs: nowMs,
        deliveredEvidenceFingerprint: approval.evidenceFingerprint,
        lastGuideSource: "auto",
        updatedAtMs: nowMs,
      });
      yield* Effect.logInfo("Mem guided a thread (proceeded after no answer).", {
        threadId: approval.threadId,
      });
    }
    return settledThreads;
  });

  const pendingApprovals = Effect.fn("MemOverseerService.pendingApprovals")(function* () {
    const pending = yield* ports.store
      .approvals()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mem could not read its pending approvals.", { cause }).pipe(
            Effect.as([] as ReadonlyArray<MemPendingApprovalRecord>),
          ),
        ),
      );
    return pending.map((approval): MemPendingApproval => ({
      approvalId: approval.approvalId,
      threadId: approval.threadId,
      instruction: approval.instruction,
      createdAtMs: approval.createdAtMs,
      evidenceFingerprint: approval.evidenceFingerprint,
      blocking: approval.blocking,
    }));
  });

  const answerApproval = Effect.fn("MemOverseerService.answerApproval")(function* (
    input: MemAnswerApprovalInput,
  ) {
    const record = yield* ports.store.get(input.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Mem could not read a task's state.", {
          threadId: input.threadId,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );
    const pending = record?.pendingApproval ?? null;
    if (record === undefined || pending === null || pending.approvalId !== input.approvalId) {
      yield* Effect.logWarning("Mem could not find the approval it was asked to answer.", {
        threadId: input.threadId,
      });
      return { outcome: "missing" as const };
    }
    const nowMs = yield* Clock.currentTimeMillis;

    if (input.decision === "deny") {
      // The loop has no deny transition: a refusal is a human escalation, and it stays escalated.
      yield* ports.store.put({
        ...record,
        task: { ...record.task, phase: "escalated", lastInstruction: null },
        settledPhase: "escalated",
        pendingApproval: null,
        updatedAtMs: nowMs,
      });
      yield* Effect.logWarning("Mem escalated a thread the owner denied.", {
        threadId: input.threadId,
      });
      return { outcome: "denied" as const };
    }

    const delivered = yield* deliver(
      {
        threadId: ThreadId.make(pending.threadId),
        projectId: ProjectId.make(pending.projectId),
      },
      pending.instruction,
    );
    if (!delivered) return { outcome: "failed" as const };

    yield* ports.store.put({
      ...record,
      pendingCharge: true,
      pendingApproval: null,
      deliveredInstruction: pending.instruction,
      deliveredAtMs: nowMs,
      deliveredEvidenceFingerprint: pending.evidenceFingerprint,
      lastGuideSource: "owner",
      updatedAtMs: nowMs,
    });
    yield* Effect.logInfo("Mem guided a thread (approved by owner).", {
      threadId: input.threadId,
    });
    return { outcome: "sent" as const };
  });

  /** A refusal is the only way a request fails: typed, warned about by name, never a defect. */
  const refuse = (
    operation: MemOverseerRequestOperation,
    reason: MemOverseerRequestReason,
    detail: string,
  ): Effect.Effect<never, MemOverseerRequestError> =>
    Effect.logWarning("Mem refused a request.", { operation, reason }).pipe(
      Effect.andThen(Effect.fail(new MemOverseerRequestError({ operation, reason, detail }))),
    );

  const readSettingsFor = (operation: MemOverseerRequestOperation) =>
    ports
      .loadSettings()
      .pipe(
        Effect.catchCause(() =>
          refuse(operation, "failure", "the overseer settings could not be read."),
        ),
      );

  const requireEnabled = (operation: MemOverseerRequestOperation, mem: MemOverseerSettings) =>
    mem.enabled ? Effect.void : refuse(operation, "disabled", "the overseer is switched off.");

  const readThreadFor = (operation: MemOverseerRequestOperation, threadId: string) =>
    ports
      .readThread(threadId)
      .pipe(Effect.catchCause(() => refuse(operation, "failure", "the thread could not be read.")));

  const spendForTurn = (mem: MemOverseerSettings) =>
    ports.store.totalSpentUsd().pipe(
      Effect.orElseSucceed(() => 0),
      Effect.map((spentUsd) => ({
        spentUsd,
        spend: decideSpend({
          capUsd: mem.spendingCapUsd,
          spentUsd,
          estimatedNextTurnUsd: MEM_ESTIMATED_TURN_USD,
        }),
      })),
    );

  /** Titles come from the owner or the first line of the prompt; both are bounded and trimmed. */
  const sessionTitle = (input: {
    readonly prompt: string;
    readonly title?: string | undefined;
  }) => {
    const given = input.title?.trim() ?? "";
    if (given !== "") return given;
    const firstLine = input.prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "");
    return (firstLine ?? "Mem session").slice(0, 80);
  };

  const listWatched = Effect.fn("MemOverseerService.listWatched")(function* () {
    const records = yield* ports.store
      .all()
      .pipe(
        Effect.catchCause(() =>
          refuse("load", "failure", "the watched threads could not be read."),
        ),
      );
    return [...records]
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .map((record): MemWatchedThread => ({
        threadId: record.task.threadId,
        phase: record.task.phase,
        rejections: record.task.rejections,
        lastInstruction: record.task.lastInstruction,
        spendUsd: record.spentUsd,
        pendingApproval: record.pendingApproval !== null,
      }));
  });

  const threadState = Effect.fn("MemOverseerService.threadState")(function* (threadId: string) {
    const record = yield* ports.store
      .get(threadId)
      .pipe(
        Effect.catchCause(() =>
          refuse("load", "failure", "the thread's Mem state could not be read."),
        ),
      );
    const review = record?.lastReview ?? null;
    const masterThreadId = yield* ports
      .findMasterThreadId()
      .pipe(Effect.orElseSucceed(() => undefined));
    return {
      verdict: review?.verdict ?? null,
      reason: review?.reasoning ?? null,
      masterThreadId: masterThreadId ?? null,
    } satisfies MemThreadState;
  });

  /**
   * The same plan-then-review path the tick takes, so a verdict reached from chat is the verdict
   * the next tick would reach for the same code. It records what it found and never sends.
   */
  const reviewThreadNow = Effect.fn("MemOverseerService.reviewThreadNow")(function* (
    threadId: string,
  ) {
    return yield* actorLock
      .withPermit(
        Effect.gen(function* () {
          const settings = yield* readSettingsFor("review");
          yield* requireEnabled("review", settings.mem);
          const thread = yield* readThreadFor("review", threadId);
          if (thread === undefined) {
            return yield* refuse("review", "thread_not_found", "no thread has that id.");
          }
          if (settings.pace.kind === "unset") {
            return yield* refuse("review", "no_model", "no review model is set.");
          }

          const plan = yield* ports
            .planReview(thread)
            .pipe(
              Effect.catchCause(() =>
                refuse("review", "failure", "the thread's change set could not be read."),
              ),
            );
          const outcome = yield* reviewBatches(thread, plan, settings.mem, settings.pace.selection);

          const nowMs = yield* Clock.currentTimeMillis;
          const existing = yield* ports.store
            .get(threadId)
            .pipe(Effect.orElseSucceed(() => undefined as MemOverseerTaskRecord | undefined));
          const record = yield* charge(existing ?? newTaskRecord(threadId, nowMs), outcome.costUsd);

          if (outcome.type === "parked") {
            yield* ports.store.put({
              ...record,
              task: reduceTask(record.task, { type: "capReached" }),
              settledPhase: "parked",
              pendingApproval: null,
              updatedAtMs: nowMs,
            });
            const total = yield* ports.store.totalSpentUsd().pipe(Effect.orElseSucceed(() => 0));
            yield* Effect.logWarning("Mem parked a thread instead of reviewing it.", {
              threadId,
              spend: describeCap({ capUsd: settings.mem.spendingCapUsd, spentUsd: total }),
            });
            return yield* refuse(
              "review",
              "cap_reached",
              "the spending cap has no budget for another review batch.",
            );
          }

          if (outcome.result === null) {
            return yield* refuse("review", "failure", "the review produced no verdict.");
          }

          yield* ports.store.put({
            ...record,
            task: reduceTask(record.task, { type: "reviewed", result: outcome.result }),
            lastReview: {
              verdict: outcome.result.verdict,
              reasoning: outcome.result.reasoning,
            },
            updatedAtMs: nowMs,
          });
          return {
            verdict: outcome.result.verdict,
            findings: outcome.result.findings,
            reasoning: outcome.result.reasoning,
            nextInstruction: outcome.result.nextInstruction,
            accepted: outcome.result.usable && outcome.result.verdict === "accept",
          } satisfies MemThreadReview;
        }),
      )
      .pipe(Effect.catchDefect(() => refuse("review", "failure", "the review did not complete.")));
  });

  /**
   * A chat instruction takes the tick's exact path: budget first, then the destructive guard, then
   * one delivery. A blocked instruction joins the same approval queue and waits there for a human.
   */
  const sendInstruction = Effect.fn("MemOverseerService.sendInstruction")(function* (
    threadId: string,
    instruction: string,
  ) {
    return yield* actorLock
      .withPermit(
        Effect.gen(function* () {
          const settings = yield* readSettingsFor("send-instruction");
          yield* requireEnabled("send-instruction", settings.mem);
          const thread = yield* readThreadFor("send-instruction", threadId);
          if (thread === undefined) {
            return yield* refuse("send-instruction", "thread_not_found", "no thread has that id.");
          }

          const nowMs = yield* Clock.currentTimeMillis;
          const existing = yield* ports.store
            .get(threadId)
            .pipe(Effect.orElseSucceed(() => undefined as MemOverseerTaskRecord | undefined));
          let record = existing ?? newTaskRecord(threadId, nowMs);

          // The same text is never handed to a session twice, whether it already went out or waits.
          if (record.deliveredInstruction === instruction) {
            return { sent: false, parked: "already_delivered" } satisfies MemSendInstructionResult;
          }
          if (record.pendingApproval?.instruction === instruction) {
            return { sent: false, parked: "approval_required" } satisfies MemSendInstructionResult;
          }

          const { spentUsd, spend } = yield* spendForTurn(settings.mem);
          if (!spend.allowed) {
            const parked = reduceTask(record.task, { type: "capReached" });
            yield* ports.store.put({
              ...record,
              task: parked,
              settledPhase: parked.phase,
              pendingApproval: null,
              updatedAtMs: nowMs,
            });
            yield* Effect.logWarning("Mem parked a thread instead of sending a chat instruction.", {
              threadId,
              spend: describeCap({ capUsd: settings.mem.spendingCapUsd, spentUsd }),
            });
            return { sent: false, parked: "cap_reached" } satisfies MemSendInstructionResult;
          }

          // The same signals the tick measures: the words, plus the change set when it can be read.
          const plan = yield* ports.planReview(thread).pipe(Effect.orElseSucceed(() => null));
          if (
            isDestructiveDeletion({
              instruction,
              evidence: thread.evidence,
              deletedLines: plan?.deletedLines ?? 0,
              deletedFiles: plan?.deletedFiles ?? [],
            })
          ) {
            const fingerprint = fingerprintEvidence(thread.evidence);
            yield* ports.store.put({
              ...record,
              // The queued text becomes the pending instruction, so a later tick waits on the same
              // human answer instead of reviewing the thread and replacing it.
              task: { ...record.task, phase: "claimed", lastInstruction: instruction },
              pendingApproval: {
                approvalId: fingerprint,
                threadId: thread.threadId,
                projectId: thread.projectId,
                instruction,
                createdAtMs: nowMs,
                evidenceFingerprint: fingerprint,
                blocking: true,
              },
              updatedAtMs: nowMs,
            });
            yield* Effect.logWarning(
              "Mem blocked a destructive chat instruction (awaiting owner).",
              {
                threadId,
              },
            );
            return { sent: false, parked: "approval_required" } satisfies MemSendInstructionResult;
          }

          const delivered = yield* deliver(
            { threadId: thread.threadId, projectId: thread.projectId },
            instruction,
          );
          if (!delivered) return { sent: false } satisfies MemSendInstructionResult;

          yield* ports.store.put({
            ...record,
            task: { ...record.task, phase: "claimed", lastInstruction: instruction },
            // An owner who steers a settled thread reopens it for review.
            settledPhase: null,
            pendingCharge: true,
            pendingApproval: null,
            deliveredInstruction: instruction,
            deliveredAtMs: nowMs,
            deliveredEvidenceFingerprint: fingerprintEvidence(thread.evidence),
            lastGuideSource: "owner",
            updatedAtMs: nowMs,
          });
          yield* Effect.logInfo("Mem sent a chat instruction.", { threadId });
          return { sent: true } satisfies MemSendInstructionResult;
        }),
      )
      .pipe(
        Effect.catchDefect(() =>
          refuse("send-instruction", "failure", "the instruction could not be sent."),
        ),
      );
  });

  const setLifecycle = Effect.fn("MemOverseerService.setLifecycle")(function* (
    threadId: string,
    lifecycle: MemThreadLifecycle,
  ) {
    // Marking a thread starts no turn, so this path reads no budget.
    yield* actorLock
      .withPermit(
        Effect.gen(function* () {
          yield* ports
            .setLifecycle(threadId, lifecycle)
            .pipe(
              Effect.catchCause(() =>
                refuse(
                  "set-lifecycle",
                  "failure",
                  "the lifecycle command could not be dispatched.",
                ),
              ),
            );
          // Re-opening a settled thread must let the loop review it again.
          if (lifecycle !== "in_progress") return;
          const existing = yield* ports.store
            .get(threadId)
            .pipe(Effect.orElseSucceed(() => undefined as MemOverseerTaskRecord | undefined));
          if (existing === undefined) return;
          const nowMs = yield* Clock.currentTimeMillis;
          yield* ports.store.put({
            ...existing,
            task: startTask(threadId),
            settledPhase: null,
            pendingApproval: null,
            updatedAtMs: nowMs,
          });
        }),
      )
      .pipe(
        Effect.catchDefect(() =>
          refuse("set-lifecycle", "failure", "the lifecycle command could not be dispatched."),
        ),
      );
  });

  const spawnSession = Effect.fn("MemOverseerService.spawnSession")(function* (input: {
    readonly prompt: string;
    readonly title?: string | undefined;
    readonly modelSelection: ModelSelection;
  }) {
    return yield* actorLock
      .withPermit(
        Effect.gen(function* () {
          const settings = yield* readSettingsFor("spawn");
          yield* requireEnabled("spawn", settings.mem);
          const spawnDirectory = settings.mem.spawnDirectory.trim();
          if (spawnDirectory === "") {
            return yield* refuse(
              "spawn",
              "spawn_directory_empty",
              "no spawn directory is configured.",
            );
          }
          const projectId = yield* ports
            .findProjectForDirectory(spawnDirectory)
            .pipe(
              Effect.catchCause(() =>
                refuse("spawn", "failure", "the projects could not be read."),
              ),
            );
          if (projectId === undefined) {
            return yield* refuse(
              "spawn",
              "spawn_project_missing",
              "the spawn directory is not a project workspace.",
            );
          }

          const { spentUsd, spend } = yield* spendForTurn(settings.mem);
          if (!spend.allowed) {
            yield* Effect.logWarning(
              "Mem refused to spawn a session: no budget for its first turn.",
              {
                spend: describeCap({ capUsd: settings.mem.spendingCapUsd, spentUsd }),
              },
            );
            return yield* refuse(
              "spawn",
              "cap_reached",
              "the spending cap has no budget for a new session.",
            );
          }

          const spawned = yield* ports
            .spawnSession({
              projectId,
              spawnDirectory,
              prompt: input.prompt,
              title: sessionTitle(input),
              modelSelection: input.modelSelection,
            })
            .pipe(
              Effect.catchCause(() =>
                refuse("spawn", "failure", "the session could not be created."),
              ),
            );

          const nowMs = yield* Clock.currentTimeMillis;
          yield* ports.store.put({
            ...newTaskRecord(spawned.threadId, nowMs),
            // The prompt is already in the new thread, so the loop must never send it again.
            pendingCharge: true,
            deliveredInstruction: input.prompt,
            deliveredAtMs: nowMs,
            deliveredEvidenceFingerprint: null,
            lastGuideSource: "owner",
            updatedAtMs: nowMs,
          });
          yield* Effect.logInfo("Mem spawned a session.", { threadId: spawned.threadId });
          return { threadId: spawned.threadId };
        }),
      )
      .pipe(
        Effect.catchDefect(() => refuse("spawn", "failure", "the session could not be created.")),
      );
  });

  const tick = Effect.fn("MemOverseerService.tick")(function* () {
    const settings = yield* ports
      .loadSettings()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mem could not read its settings.", { cause }).pipe(Effect.as(null)),
        ),
      );
    if (settings === null || !settings.mem.enabled) return;

    if (settings.pace.kind !== "premium") {
      yield* Effect.logInfo("Mem chose its review model.", {
        tier: settings.pace.kind,
        reason: settings.pace.reason,
      });
    }

    const ownerAway = yield* ports
      .isOwnerAway(settings.mem.idleThresholdMinutes)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mem could not read the idle clock.", { cause }).pipe(Effect.as(false)),
        ),
      );

    // Nothing answered the last question, so Mem's own recommendation goes out before anything new.
    const settledThreads = yield* actorLock.withPermit(expireApprovals(settings.mem));

    const threads = yield* ports
      .listThreads()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mem could not list threads.", { cause }).pipe(
            Effect.as([] as ReadonlyArray<MemOverseerThread>),
          ),
        ),
      );
    if (threads.length === 0) return;

    // Sequential on purpose: one action per thread, and each thread re-reads spend, so anything
    // booked while this tick ran is already counted.
    // Each thread is one actor action, so a chat request can take the lock between threads only.
    yield* Effect.forEach(
      threads.filter((thread) => !settledThreads.has(thread.threadId)),
      (thread) =>
        actorLock.withPermit(runThread(thread, settings.mem, settings.pace, ownerAway)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Mem skipped a thread after an unexpected failure.", {
              threadId: thread.threadId,
              cause,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  return {
    tick,
    pendingApprovals,
    answerApproval,
    listWatched,
    threadState,
    reviewThreadNow,
    sendInstruction,
    setLifecycle,
    spawnSession,
  };
};

export class MemOverseerService extends Context.Service<
  MemOverseerService,
  MemOverseerServiceShape
>()("t3/overseer/MemOverseerService") {}

/** The review model follows the owner's pace choice: premium, economy, or unset. */
const resolveOverseerModelSelection = (
  settings: ServerSettingsValue,
  fractions: Pick<MemPaceInputs, "usedFraction" | "elapsedFraction">,
): MemPaceDecision =>
  chooseModel({
    paceMode: settings.mem.paceMode,
    premium: settings.mem.premiumModelSelection,
    economy: settings.mem.economyModelSelection,
    ...fractions,
  });

interface PaceFractions {
  readonly usedFraction: number | null;
  readonly elapsedFraction: number | null;
}

const UNKNOWN_PACE: PaceFractions = { usedFraction: null, elapsedFraction: null };

/**
 * The weekly window belongs to the login Mem spends on. Provider snapshots are already in memory,
 * so this costs nothing per tick; a missing window or an unreadable snapshot reads as unknown.
 */
const readWeeklyPace = Effect.fn("MemOverseerService.readWeeklyPace")(function* (
  instances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  selection: ModelSelection | null,
  nowMs: number,
) {
  if (selection === null) return UNKNOWN_PACE;
  const instance = yield* instances.getInstance(selection.instanceId);
  if (instance === undefined) return UNKNOWN_PACE;
  const provider = yield* instance.snapshot.getSnapshot;
  const window = provider.usageLimits?.windows.find((entry) => entry.kind === "weekly");
  if (window === undefined) return UNKNOWN_PACE;
  return {
    usedFraction: window.usedPercent / 100,
    elapsedFraction: elapsedShare(window, nowMs),
  };
});

interface RecentActivity {
  readonly lastUserText: string;
  readonly lastAssistantText: string;
  /** Every touched path, keyed so a later touch replaces the earlier counts. */
  readonly files: Map<string, MemChangedFile>;
  readonly hasWork: boolean;
}

const emptyActivity = (): RecentActivity => ({
  lastUserText: "",
  lastAssistantText: "",
  files: new Map(),
  hasWork: false,
});

/** One pass over the thread's items: the tail of the transcript plus the whole change set. */
const summarizeActivity = (
  current: RecentActivity,
  entry: OrchestrationV2ProjectedTurnItem,
): RecentActivity => {
  const item = entry.item;
  switch (item.type) {
    case "user_message":
      return {
        ...current,
        hasWork: true,
        lastUserText: item.text.slice(0, MEM_EVIDENCE_MAX_LENGTH),
      };
    case "assistant_message":
      return {
        ...current,
        lastAssistantText: item.text.slice(0, MEM_EVIDENCE_MAX_LENGTH),
      };
    case "file_change":
      // Every file, not the last handful: the reviewer reads code, not a digest.
      current.files.set(item.fileName, {
        path: item.fileName,
        ...(item.additions === undefined ? {} : { additions: item.additions }),
        ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
      });
      return current;
    default:
      return current;
  }
};

const readRecentActivity = Effect.fn("MemOverseerService.readRecentActivity")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
) {
  let activity = emptyActivity();
  let afterPosition = -1;
  for (let page = 0; page < MEM_TIMELINE_MAX_PAGES; page += 1) {
    const result = yield* projections
      .getTimelinePage(threadId, {
        view: "activity",
        afterPosition,
        limit: MEM_TIMELINE_PAGE_SIZE,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MemOverseerFailure({
              operation: "read-activity",
              detail: "the thread's activity could not be read.",
              cause,
            }),
        ),
      );
    if (result.items.length === 0) break;
    for (const entry of result.items) activity = summarizeActivity(activity, entry);
    const last = result.items[result.items.length - 1];
    if (last === undefined || !result.hasMore) break;
    afterPosition = last.position;
  }
  return activity;
});

/**
 * The newest completed provider turn, reduced to the two things the cap needs. The provider turn
 * is where a real per-turn cost lives; a provider that reports none leaves `costUsd` null.
 */
const readLastTurn = Effect.fn("MemOverseerService.readLastTurn")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
): Effect.fn.Return<MemOverseerLastTurn | null> {
  const records = yield* projections
    .getThreadRecords(threadId, ["providerTurns"])
    .pipe(Effect.option);
  if (Option.isNone(records)) return null;

  let last: MemOverseerLastTurn | null = null;
  for (const turn of records.value.providerTurns) {
    if (turn.status !== "completed" || turn.completedAt === null) continue;
    const completedAtMs = DateTime.toEpochMillis(turn.completedAt);
    if (last !== null && completedAtMs <= last.completedAtMs) continue;
    last = { completedAtMs, costUsd: turn.turnTokenUsage?.costUsd ?? null };
  }
  return last;
});

const toThread = (
  shell: OrchestrationV2ThreadShell,
  activity: RecentActivity,
  root: string | null,
  lastTurn: MemOverseerLastTurn | null,
): MemOverseerThread => ({
  threadId: shell.id,
  projectId: shell.projectId,
  title: shell.title,
  idle:
    shell.status === "idle" &&
    shell.activeRunId === null &&
    shell.pendingRuntimeRequest === null &&
    (shell.pendingBackgroundTasks ?? []).length === 0,
  hasWork: activity.hasWork,
  task: [shell.title, activity.lastUserText].filter((part) => part.trim() !== "").join("\n\n"),
  acceptance: shell.goal?.objective ?? DEFAULT_ACCEPTANCE,
  root,
  files: [...activity.files.values()],
  evidence: activity.lastAssistantText,
  lastTurn,
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const idleTracker = yield* MemIdleTracker;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const reviewer = yield* MemReviewer;
  const store = yield* MemOverseerTaskStore;
  const random = yield* SecureRandom.SecureRandom;
  const scheduler = yield* Scheduler.Scheduler;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const shellSnapshot = () =>
    projections.getShellSnapshot({ location: "active" }).pipe(
      Effect.mapError(
        (cause) =>
          new MemOverseerFailure({
            operation: "list-threads",
            detail: "the thread shell could not be read.",
            cause,
          }),
      ),
    );

  /** One project lookup per project, not per thread: a worktree is preferred when it exists. */
  const rootForShell = Effect.fn("MemOverseerService.rootForShell")(function* (
    shell: OrchestrationV2ThreadShell,
    roots: Map<string, string | null>,
  ) {
    if (shell.worktreePath) return shell.worktreePath;
    const cached = roots.get(shell.projectId);
    if (cached !== undefined) return cached;
    const project = yield* projects.getShell(shell.projectId).pipe(
      Effect.map((value) => Option.getOrUndefined(value)),
      Effect.orElseSucceed(() => undefined),
    );
    const root = project?.workspaceRoot ?? null;
    roots.set(shell.projectId, root);
    return root;
  });

  const threadForShell = (shell: OrchestrationV2ThreadShell, roots: Map<string, string | null>) =>
    Effect.map(
      Effect.all([
        readRecentActivity(projections, shell.id),
        rootForShell(shell, roots),
        readLastTurn(projections, shell.id),
      ]),
      ([activity, root, lastTurn]) => toThread(shell, activity, root, lastTurn),
    );

  /** The same directory comparison the project store makes: resolved absolute paths. */
  const resolvedDirectory = (value: string) => path.resolve(value.trim());

  const service = makeMemOverseerService({
    loadSettings: Effect.fn("MemOverseerService.loadSettings")(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new MemOverseerFailure({
              operation: "load-settings",
              detail: "the settings could not be read.",
              cause,
            }),
        ),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      // One read per tick, before any thread runs, so every thread in this tick shares one pace.
      const fractions = yield* readWeeklyPace(
        providerInstances,
        current.mem.premiumModelSelection ?? current.mem.economyModelSelection,
        nowMs,
      ).pipe(Effect.catchCause(() => Effect.succeed(UNKNOWN_PACE)));
      const pace = resolveOverseerModelSelection(current, fractions);
      return {
        mem: current.mem,
        modelSelection: pace.kind === "unset" ? null : pace.selection,
        pace,
      };
    }),
    isOwnerAway: (thresholdMinutes) =>
      idleTracker.isOwnerAway(thresholdMinutes).pipe(
        Effect.mapError(
          (cause) =>
            new MemOverseerFailure({
              operation: "read-idle",
              detail: "the idle clock could not be read.",
              cause,
            }),
        ),
      ),
    listThreads: Effect.fn("MemOverseerService.listThreads")(function* () {
      const snapshot = yield* shellSnapshot();
      const claimed = snapshot.threads.filter(
        (shell) => (shell.lifecycle ?? "none") === "in_progress" && !isMemMasterThread(shell),
      );
      const roots = new Map<string, string | null>();
      return yield* Effect.forEach(claimed, (shell) => threadForShell(shell, roots));
    }),
    readThread: Effect.fn("MemOverseerService.readThread")(function* (threadId) {
      const snapshot = yield* shellSnapshot();
      const shell = snapshot.threads.find((entry) => entry.id === threadId);
      if (shell === undefined) return undefined;
      return yield* threadForShell(shell, new Map());
    }),
    planReview: Effect.fn("MemOverseerService.planReview")(function* (thread) {
      if (thread.root === null) {
        return yield* new MemOverseerFailure({
          operation: "review",
          detail: "the thread has no workspace root to read.",
        });
      }
      const input = { root: thread.root, files: thread.files };
      const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      const batches = yield* provided(partitionReviewContext(input)).pipe(
        Effect.mapError(
          (cause) =>
            new MemOverseerFailure({
              operation: "review",
              detail: "the change set could not be split for review.",
              cause,
            }),
        ),
      );
      const context = yield* provided(buildReviewContext(input)).pipe(
        Effect.mapError(
          (cause) =>
            new MemOverseerFailure({
              operation: "review",
              detail: "the change set could not be read.",
              cause,
            }),
        ),
      );
      return {
        batches: batches.map((batch) => batch.text),
        deletedLines: context.deletedLines,
        deletedFiles: context.deletedFiles,
      };
    }),
    review: (input) =>
      reviewer
        .review({
          template: input.template,
          task: input.task,
          acceptance: input.acceptance,
          changes: input.changes,
          evidence: input.evidence,
          modelSelection: input.modelSelection,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MemOverseerFailure({
                operation: "review",
                detail: "the reviewer did not answer.",
                cause,
              }),
          ),
        ),
    guide: Effect.fn("MemOverseerService.guide")(function* (target, instruction) {
      const id = yield* random.uuidV4();
      yield* threads
        .sendToThread({
          projectId: target.projectId,
          commandId: CommandId.make(`mem-guide:${id}`),
          messageId: MessageId.make(id),
          threadId: target.threadId,
          text: instruction,
          attachments: [],
          mode: "auto",
          createdBy: "agent", // Shows as "Sent by Mem" instead of as the owner's own words.
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MemOverseerFailure({
                operation: "guide",
                detail: "the instruction could not be sent.",
                cause,
              }),
          ),
        );
    }),
    complete: Effect.fn("MemOverseerService.complete")(function* (thread) {
      const id = yield* random.uuidV4();
      yield* threads
        .dispatch({
          type: "thread.lifecycle.set",
          commandId: CommandId.make(`mem-accept:${id}`),
          threadId: thread.threadId,
          lifecycle: "complete",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MemOverseerFailure({
                operation: "complete",
                detail: "the lifecycle command could not be dispatched.",
                cause,
              }),
          ),
        );
    }),
    setLifecycle: Effect.fn("MemOverseerService.setLifecycleCommand")(
      function* (threadId, lifecycle) {
        const id = yield* random.uuidV4();
        yield* threads
          .dispatch({
            type: "thread.lifecycle.set",
            commandId: CommandId.make(`mem-lifecycle:${id}`),
            threadId: ThreadId.make(threadId),
            lifecycle,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new MemOverseerFailure({
                  operation: "lifecycle",
                  detail: "the lifecycle command could not be dispatched.",
                  cause,
                }),
            ),
          );
      },
    ),
    findProjectForDirectory: Effect.fn("MemOverseerService.findProjectForDirectory")(
      function* (directory) {
        const rows = yield* projects.list().pipe(
          Effect.mapError(
            (cause) =>
              new MemOverseerFailure({
                operation: "spawn",
                detail: "the projects could not be read.",
                cause,
              }),
          ),
        );
        const wanted = resolvedDirectory(directory);
        return rows.find((row) => resolvedDirectory(row.workspaceRoot) === wanted)?.projectId;
      },
    ),
    findMasterThreadId: Effect.fn("MemOverseerService.findMasterThreadId")(function* () {
      const snapshot = yield* shellSnapshot();
      return snapshot.threads.find((shell) => shell.memMaster === true)?.id;
    }),
    spawnSession: Effect.fn("MemOverseerService.spawn")(function* (input) {
      const id = yield* random.uuidV4();
      const sessionDirectory = path.join(input.spawnDirectory, `mem-${id.slice(0, 8)}`);
      // The session gets its own folder under the configured directory; nothing else is guessed.
      yield* fileSystem.makeDirectory(sessionDirectory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new MemOverseerFailure({
              operation: "spawn",
              detail: "the session folder could not be created.",
              cause,
            }),
        ),
      );
      const threadId = ThreadId.make(`thread-${id}`);
      yield* threads
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "server",
          commandId: CommandId.make(`mem-spawn:${id}`),
          threadId,
          projectId: ProjectId.make(input.projectId),
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: sessionDirectory,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MemOverseerFailure({
                operation: "spawn",
                detail: "the thread could not be created.",
                cause,
              }),
          ),
        );
      yield* threads
        .sendToThread({
          projectId: ProjectId.make(input.projectId),
          commandId: CommandId.make(`mem-spawn-prompt:${id}`),
          messageId: MessageId.make(id),
          threadId,
          text: input.prompt,
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MemOverseerFailure({
                operation: "spawn",
                detail: "the first message could not be sent.",
                cause,
              }),
          ),
        );
      return { threadId };
    }),
    store,
  });

  const lastTickMs = yield* Ref.make(0);
  const gated = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(lastTickMs);
    if (nowMs - previous < MEM_OVERSEER_TICK_INTERVAL_MS) return;
    yield* Ref.set(lastTickMs, nowMs);
    yield* service.tick();
  });

  yield* scheduler.register("mem-overseer", gated);

  return MemOverseerService.of(service);
});

export const layer = Layer.effect(MemOverseerService, make);
