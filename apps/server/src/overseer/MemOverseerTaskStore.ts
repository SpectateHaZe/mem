/**
 * Durable task state for the Mem overseer.
 *
 * What Mem delivered has to outlive the process: a restart that forgot an instruction would send
 * the same message twice, and a cap that forgot its spend would overshoot. One small JSON file,
 * bounded to the threads Mem has claimed and pruned oldest-first.
 */

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { startTask, type MemTaskPhase, type MemTaskState } from "./MemOverseerLoop.ts";

const MEM_TASKS_FILE_NAME = "mem-overseer-tasks.json";

/** Older records drop past this, so a long-lived install cannot grow the file without a ceiling. */
export const MEM_TRACKED_TASK_LIMIT = 200;

/** Whether a human was around for the last guide: `owner` present, `auto` nobody answered. */
export type MemGuideSource = "owner" | "auto";

/**
 * An instruction Mem proposed and did not send. The id is the evidence fingerprint it was based
 * on, so the same thread state can only ever hold one question.
 */
export interface MemPendingApprovalRecord {
  readonly approvalId: string;
  readonly threadId: string;
  /** Carried so an approval can be sent after the thread left the claimed list. */
  readonly projectId: string;
  readonly instruction: string;
  readonly createdAtMs: number;
  readonly evidenceFingerprint: string;
  /** A destructive deletion waits for a real answer; the timeout never applies to it. */
  readonly blocking: boolean;
}

export interface MemOverseerTaskRecord {
  readonly task: MemTaskState;
  /** Estimated turn spend in USD, carried next to the state so a restart keeps the budget spent. */
  readonly spentUsd: number;
  /** The last usable verdict Mem reached, so a client can show it without paying for a review. */
  readonly lastReview: MemReviewSummary | null;
  /** The last instruction actually handed to the session; a restart must never resend it. */
  readonly deliveredInstruction: string | null;
  readonly deliveredAtMs: number | null;
  /** Fingerprint of the evidence the turn was started against, so "no new output" is visible. */
  readonly deliveredEvidenceFingerprint: string | null;
  /** One-time side effects already written or logged for a terminal phase. */
  readonly settledPhase: MemTaskPhase | null;
  /** A `mode: "ask"` instruction waiting for the owner, cleared by an answer or by the clock. */
  readonly pendingApproval: MemPendingApprovalRecord | null;
  readonly lastGuideSource: MemGuideSource | null;
  readonly updatedAtMs: number;
}

export interface MemReviewSummary {
  readonly verdict: "accept" | "reject";
  readonly reasoning: string;
}

export const newTaskRecord = (threadId: string, nowMs: number): MemOverseerTaskRecord => ({
  task: startTask(threadId),
  spentUsd: 0,
  lastReview: null,
  deliveredInstruction: null,
  deliveredAtMs: null,
  deliveredEvidenceFingerprint: null,
  settledPhase: null,
  pendingApproval: null,
  lastGuideSource: null,
  updatedAtMs: nowMs,
});

const PersistedPendingApproval = Schema.Struct({
  approvalId: Schema.String,
  threadId: Schema.String,
  projectId: Schema.String,
  instruction: Schema.String,
  createdAtMs: Schema.Int,
  evidenceFingerprint: Schema.String,
  // Optional so a file written before the destructive block existed still decodes.
  blocking: Schema.optionalKey(Schema.Boolean),
});

const PersistedTaskRecord = Schema.Struct({
  threadId: Schema.String,
  phase: Schema.Literals(["claimed", "awaitingReview", "accepted", "escalated", "parked"]),
  rejections: Schema.Int,
  lastInstruction: Schema.NullOr(Schema.String),
  spentUsd: Schema.Finite,
  // Optional so a file written before verdicts were persisted still decodes.
  lastReview: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        verdict: Schema.Literals(["accept", "reject"]),
        reasoning: Schema.String,
      }),
    ),
  ),
  deliveredInstruction: Schema.NullOr(Schema.String),
  deliveredAtMs: Schema.NullOr(Schema.Int),
  deliveredEvidenceFingerprint: Schema.NullOr(Schema.String),
  settledPhase: Schema.NullOr(
    Schema.Literals(["claimed", "awaitingReview", "accepted", "escalated", "parked"]),
  ),
  // Optional so a file written before approvals existed still decodes.
  pendingApproval: Schema.optionalKey(Schema.NullOr(PersistedPendingApproval)),
  lastGuideSource: Schema.optionalKey(Schema.NullOr(Schema.Literals(["owner", "auto"]))),
  updatedAtMs: Schema.Int,
});

const PersistedMemTasks = Schema.Struct({
  version: Schema.Literal(1),
  tasks: Schema.Array(PersistedTaskRecord),
});

const decodePersistedMemTasks = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedMemTasks),
);

const toPersisted = (record: MemOverseerTaskRecord) => ({
  threadId: record.task.threadId,
  phase: record.task.phase,
  rejections: record.task.rejections,
  lastInstruction: record.task.lastInstruction,
  spentUsd: record.spentUsd,
  lastReview: record.lastReview,
  deliveredInstruction: record.deliveredInstruction,
  deliveredAtMs: record.deliveredAtMs,
  deliveredEvidenceFingerprint: record.deliveredEvidenceFingerprint,
  settledPhase: record.settledPhase,
  pendingApproval: record.pendingApproval,
  lastGuideSource: record.lastGuideSource,
  updatedAtMs: record.updatedAtMs,
});

const fromPersisted = (persisted: typeof PersistedTaskRecord.Type): MemOverseerTaskRecord => ({
  task: {
    threadId: persisted.threadId,
    phase: persisted.phase,
    rejections: persisted.rejections,
    lastInstruction: persisted.lastInstruction,
  },
  spentUsd: persisted.spentUsd,
  lastReview: persisted.lastReview ?? null,
  deliveredInstruction: persisted.deliveredInstruction,
  deliveredAtMs: persisted.deliveredAtMs,
  deliveredEvidenceFingerprint: persisted.deliveredEvidenceFingerprint,
  settledPhase: persisted.settledPhase,
  pendingApproval:
    persisted.pendingApproval === undefined || persisted.pendingApproval === null
      ? null
      : { ...persisted.pendingApproval, blocking: persisted.pendingApproval.blocking ?? false },
  lastGuideSource: persisted.lastGuideSource ?? null,
  updatedAtMs: persisted.updatedAtMs,
});

/** Keeps the newest records; a corrupt record anywhere rejects the whole file. */
const prune = (
  records: ReadonlyArray<MemOverseerTaskRecord>,
): ReadonlyArray<MemOverseerTaskRecord> =>
  [...records]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, MEM_TRACKED_TASK_LIMIT);

export class MemOverseerTaskStore extends Context.Service<
  MemOverseerTaskStore,
  {
    readonly all: () => Effect.Effect<ReadonlyArray<MemOverseerTaskRecord>>;
    readonly get: (threadId: string) => Effect.Effect<MemOverseerTaskRecord | undefined>;
    readonly put: (record: MemOverseerTaskRecord) => Effect.Effect<void>;
    readonly totalSpentUsd: () => Effect.Effect<number>;
    /** Every unanswered question, oldest first. Bounded by the same record ceiling. */
    readonly approvals: () => Effect.Effect<ReadonlyArray<MemPendingApprovalRecord>>;
  }
>()("t3/overseer/MemOverseerTaskStore") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const statePath = path.join(config.stateDir, MEM_TASKS_FILE_NAME);

  const load = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.orElseSucceed(() => ""));
    const decoded = decodePersistedMemTasks(raw.trim());
    return Option.match(decoded, {
      onNone: () => new Map<string, MemOverseerTaskRecord>(),
      onSome: (persisted) =>
        new Map(persisted.tasks.map((task) => [task.threadId, fromPersisted(task)] as const)),
    });
  });

  const records = yield* Ref.make(yield* load);
  // One permit covers the snapshot and the write, so an older write cannot land last.
  const writeLock = yield* Semaphore.make(1);

  const persist = (snapshot: ReadonlyArray<MemOverseerTaskRecord>) =>
    writeFileStringAtomically({
      filePath: statePath,
      contents: `${JSON.stringify({ version: 1, tasks: snapshot.map(toPersisted) })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      // Best effort: memory stays authoritative for this process, as with the idle clock.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not persist the Mem task state.", { cause }),
      ),
    );

  const all = Effect.fn("MemOverseerTaskStore.all")(function* () {
    return [...(yield* Ref.get(records)).values()];
  });

  const get = Effect.fn("MemOverseerTaskStore.get")(function* (threadId: string) {
    return (yield* Ref.get(records)).get(threadId);
  });

  const put = Effect.fn("MemOverseerTaskStore.put")(function* (record: MemOverseerTaskRecord) {
    yield* writeLock.withPermit(
      Effect.gen(function* () {
        const next = yield* Ref.modify(records, (current) => {
          const updated = new Map(current);
          updated.set(record.task.threadId, record);
          const bounded = prune([...updated.values()]);
          return [bounded, new Map(bounded.map((entry) => [entry.task.threadId, entry] as const))];
        });
        yield* persist(next);
      }),
    );
  });

  const totalSpentUsd = Effect.fn("MemOverseerTaskStore.totalSpentUsd")(function* () {
    const current = yield* Ref.get(records);
    let total = 0;
    for (const record of current.values()) {
      if (Number.isFinite(record.spentUsd)) total += record.spentUsd;
    }
    return total;
  });

  const approvals = Effect.fn("MemOverseerTaskStore.approvals")(function* () {
    const current = yield* Ref.get(records);
    return [...current.values()]
      .flatMap((record) => (record.pendingApproval === null ? [] : [record.pendingApproval]))
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  });

  return { all, get, put, totalSpentUsd, approvals } as const;
});

export const layer = Layer.effect(MemOverseerTaskStore, make);
