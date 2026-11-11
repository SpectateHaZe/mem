/**
 * The loop that drives the Mem overseer: one tick, one decision per claimed thread. World access
 * sits behind the ports below, and every failure is logged rather than thrown so a broken provider
 * cannot wedge the tick.
 */

import {
  CommandId,
  MessageId,
  type MemAnswerApprovalInput,
  type MemAnswerApprovalResult,
  type MemOverseerSettings,
  type MemPendingApproval,
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

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
  type MemLoopAction,
  type MemTaskState,
} from "./MemOverseerLoop.ts";
import { MemReviewer } from "./MemReviewer.ts";
import { accrueSpend, decideSpend, describeCap, type SpendDecision } from "./MemSpendingCap.ts";
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

/** The change set split into review passes, plus the measured deletions the gate reads. */
export interface MemReviewPlan {
  readonly batches: ReadonlyArray<string>;
  readonly deletedLines: number;
  readonly deletedFiles: ReadonlyArray<string>;
}

/** Structural port so the tests can pass a plain object instead of building the service layers. */
export interface MemOverseerStateStore {
  readonly get: (threadId: string) => Effect.Effect<MemOverseerTaskRecord | undefined>;
  readonly put: (record: MemOverseerTaskRecord) => Effect.Effect<void>;
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
  readonly planReview: (
    thread: MemOverseerThread,
  ) => Effect.Effect<MemReviewPlan, MemOverseerFailure>;
  readonly review: (
    input: MemOverseerReviewRequest,
  ) => Effect.Effect<QualityGateResult, MemOverseerFailure>;
  readonly guide: (
    target: MemOverseerGuideTarget,
    instruction: string,
  ) => Effect.Effect<void, MemOverseerFailure>;
  readonly complete: (thread: MemOverseerThread) => Effect.Effect<void, MemOverseerFailure>;
  readonly store: MemOverseerStateStore;
}

export interface MemOverseerServiceShape {
  readonly tick: () => Effect.Effect<void>;
  readonly pendingApprovals: () => Effect.Effect<ReadonlyArray<MemPendingApproval>>;
  readonly answerApproval: (
    input: MemAnswerApprovalInput,
  ) => Effect.Effect<MemAnswerApprovalResult>;
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

  const accrueTurn = (record: MemOverseerTaskRecord): MemOverseerTaskRecord => ({
    ...record,
    spentUsd: accrueSpend({ spentUsd: record.spentUsd, actualUsd: MEM_ESTIMATED_TURN_USD })
      .spentUsd,
  });

  const charge = (record: MemOverseerTaskRecord, usd: number): MemOverseerTaskRecord =>
    usd <= 0
      ? record
      : {
          ...record,
          spentUsd: accrueSpend({ spentUsd: record.spentUsd, actualUsd: usd }).spentUsd,
        };

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
      // The call was made, so it is charged whether or not it answered.
      spentUsd = accrueSpend({ spentUsd, actualUsd: MEM_ESTIMATED_REVIEW_USD }).spentUsd;
      costUsd = accrueSpend({ spentUsd: costUsd, actualUsd: MEM_ESTIMATED_REVIEW_USD }).spentUsd;

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
    spend: SpendDecision,
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
          record = charge(record, outcome.costUsd);
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
          record = accrueTurn({
            ...record,
            pendingApproval: null,
            deliveredInstruction: action.instruction,
            deliveredAtMs: nowMs,
            deliveredEvidenceFingerprint: fingerprint,
            lastGuideSource: ownerAway ? "auto" : "owner",
          });
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

      spentUsd = accrueSpend({ spentUsd, actualUsd: MEM_ESTIMATED_TURN_USD }).spentUsd;
      yield* ports.store.put(
        accrueTurn({
          ...record,
          pendingApproval: null,
          deliveredInstruction: approval.instruction,
          deliveredAtMs: nowMs,
          deliveredEvidenceFingerprint: approval.evidenceFingerprint,
          lastGuideSource: "auto",
          updatedAtMs: nowMs,
        }),
      );
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

    yield* ports.store.put(
      accrueTurn({
        ...record,
        pendingApproval: null,
        deliveredInstruction: pending.instruction,
        deliveredAtMs: nowMs,
        deliveredEvidenceFingerprint: pending.evidenceFingerprint,
        lastGuideSource: "owner",
        updatedAtMs: nowMs,
      }),
    );
    yield* Effect.logInfo("Mem guided a thread (approved by owner).", {
      threadId: input.threadId,
    });
    return { outcome: "sent" as const };
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
    const settledThreads = yield* expireApprovals(settings.mem);

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

    const spentUsd = yield* ports.store.totalSpentUsd().pipe(Effect.orElseSucceed(() => 0));
    const spend = decideSpend({
      capUsd: settings.mem.spendingCapUsd,
      spentUsd,
      estimatedNextTurnUsd: MEM_ESTIMATED_TURN_USD,
    });

    // Sequential on purpose: one action per thread, and the spend total feeds the next decision.
    yield* Effect.forEach(
      threads.filter((thread) => !settledThreads.has(thread.threadId)),
      (thread) =>
        runThread(thread, settings.mem, spend, settings.pace, ownerAway).pipe(
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

  return { tick, pendingApprovals, answerApproval };
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

const toThread = (
  shell: OrchestrationV2ThreadShell,
  activity: RecentActivity,
  root: string | null,
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
      const snapshot = yield* projections.getShellSnapshot({ location: "active" }).pipe(
        Effect.mapError(
          (cause) =>
            new MemOverseerFailure({
              operation: "list-threads",
              detail: "the thread shell could not be read.",
              cause,
            }),
        ),
      );
      const claimed = snapshot.threads.filter(
        (shell) => (shell.lifecycle ?? "none") === "in_progress",
      );
      // One project lookup per project, not per thread: a worktree is preferred when it exists.
      const roots = new Map<string, string | null>();
      const rootFor = Effect.fn("MemOverseerService.rootFor")(function* (
        shell: OrchestrationV2ThreadShell,
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
      return yield* Effect.forEach(claimed, (shell) =>
        Effect.map(
          Effect.all([readRecentActivity(projections, shell.id), rootFor(shell)]),
          ([activity, root]) => toThread(shell, activity, root),
        ),
      );
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
          createdBy: "user",
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
