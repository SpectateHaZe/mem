import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as MemOverseerTaskStoreModule from "./MemOverseerTaskStore.ts";
import {
  MEM_TRACKED_TASK_LIMIT,
  newTaskRecord,
  type MemOverseerTaskRecord,
} from "./MemOverseerTaskStore.ts";

const withTempBaseDir = async (body: (baseDir: string) => Promise<void>) => {
  const baseDir = await Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectory({ prefix: "t3-mem-overseer-test-" }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
  try {
    await body(baseDir);
  } finally {
    await Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(baseDir, { recursive: true, force: true }),
    )
      .pipe(Effect.provide(NodeServices.layer), Effect.runPromise)
      .catch(() => undefined);
  }
};

const storeLayer = (baseDir: string) =>
  MemOverseerTaskStoreModule.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

const pendingApproval = (threadId: string, createdAtMs: number) => ({
  approvalId: `fingerprint-${threadId}`,
  threadId,
  projectId: "project-1",
  instruction: "Add the empty-input guard.",
  createdAtMs,
  evidenceFingerprint: `fingerprint-${threadId}`,
  blocking: true,
});

const recordWithApproval = (index: number): MemOverseerTaskRecord => ({
  ...newTaskRecord(`thread-${index}`, index),
  pendingApproval: pendingApproval(`thread-${index}`, index),
  updatedAtMs: index,
});

describe("MemOverseerTaskStore", () => {
  it("reloads delivered instructions and ledger spend after a restart", async () => {
    await withTempBaseDir(async (baseDir) => {
      await Effect.gen(function* () {
        const store = yield* MemOverseerTaskStoreModule.MemOverseerTaskStore;
        const nowMs = yield* Clock.currentTimeMillis;
        yield* store.put({
          ...newTaskRecord("thread-1", 1_000),
          task: {
            threadId: "thread-1",
            phase: "claimed",
            rejections: 1,
            lastInstruction: "Add the empty-input guard.",
          },
          spentUsd: 0.5,
          pendingCharge: true,
          deliveredInstruction: "Add the empty-input guard.",
          deliveredAtMs: 900,
          deliveredEvidenceFingerprint: "abc123",
        });
        yield* store.recordSpend({ atMs: nowMs, usd: 0.5, threadId: "thread-1" });
      }).pipe(Effect.provide(storeLayer(baseDir)), Effect.runPromise);

      const reloaded = await Effect.gen(function* () {
        const store = yield* MemOverseerTaskStoreModule.MemOverseerTaskStore;
        return {
          record: yield* store.get("thread-1"),
          spent: yield* store.totalSpentUsd(),
        };
      }).pipe(Effect.provide(storeLayer(baseDir)), Effect.runPromise);

      expect(reloaded.record?.deliveredInstruction).toBe("Add the empty-input guard.");
      expect(reloaded.record?.task.phase).toBe("claimed");
      expect(reloaded.record?.pendingCharge).toBe(true);
      expect(reloaded.spent).toBe(0.5);
    });
  });

  it("reloads a pending approval and who answered the last guide", async () => {
    await withTempBaseDir(async (baseDir) => {
      const queued = {
        ...newTaskRecord("thread-1", 1_000),
        pendingApproval: pendingApproval("thread-1", 1_200),
        lastGuideSource: "owner" as const,
      };
      await Effect.gen(function* () {
        const store = yield* MemOverseerTaskStoreModule.MemOverseerTaskStore;
        yield* store.put(queued);
      }).pipe(Effect.provide(storeLayer(baseDir)), Effect.runPromise);

      const reloaded = await Effect.gen(function* () {
        const store = yield* MemOverseerTaskStoreModule.MemOverseerTaskStore;
        return { record: yield* store.get("thread-1"), approvals: yield* store.approvals() };
      }).pipe(Effect.provide(storeLayer(baseDir)), Effect.runPromise);

      expect(reloaded.record?.pendingApproval).toStrictEqual(queued.pendingApproval);
      expect(reloaded.record?.lastGuideSource).toBe("owner");
      expect(reloaded.approvals).toStrictEqual([queued.pendingApproval]);
    });
  });

  it("bounds the pending approvals with the same record ceiling", async () => {
    await withTempBaseDir(async (baseDir) => {
      const extra = 5;
      const total = MEM_TRACKED_TASK_LIMIT + extra;
      const result = await Effect.gen(function* () {
        const store = yield* MemOverseerTaskStoreModule.MemOverseerTaskStore;
        yield* Effect.forEach(
          Array.from({ length: total }, (_, index) => index),
          (index) => store.put(recordWithApproval(index)),
          { discard: true },
        );
        return {
          approvals: yield* store.approvals(),
          records: yield* store.all(),
        };
      }).pipe(Effect.provide(storeLayer(baseDir)), Effect.runPromise);

      expect(result.records).toHaveLength(MEM_TRACKED_TASK_LIMIT);
      expect(result.approvals).toHaveLength(MEM_TRACKED_TASK_LIMIT);
      // Pruned oldest-first, so the oldest thread's question is the one that went.
      expect(result.approvals.map((approval) => approval.threadId)).not.toContain("thread-0");
      expect(result.approvals.map((approval) => approval.threadId)).toContain(
        `thread-${total - 1}`,
      );
    });
  });

  it("keeps spend when old task records are pruned", async () => {
    await withTempBaseDir(async (baseDir) => {
      const extra = 5;
      const total = MEM_TRACKED_TASK_LIMIT + extra;
      const result = await Effect.gen(function* () {
        const store = yield* MemOverseerTaskStoreModule.MemOverseerTaskStore;
        const nowMs = yield* Clock.currentTimeMillis;
        // The oldest record is the one pruning drops; its spend must not disappear with it.
        yield* store.recordSpend({ atMs: nowMs, usd: 0.25, threadId: "thread-0" });
        yield* Effect.forEach(
          Array.from({ length: total }, (_, index) => index),
          (index) => store.put({ ...newTaskRecord(`thread-${index}`, index), updatedAtMs: index }),
          { discard: true },
        );
        return {
          records: yield* store.all(),
          spent: yield* store.totalSpentUsd(),
        };
      }).pipe(Effect.provide(storeLayer(baseDir)), Effect.runPromise);

      expect(result.records).toHaveLength(MEM_TRACKED_TASK_LIMIT);
      expect(result.records.map((record) => record.task.threadId)).not.toContain("thread-0");
      expect(result.spent).toBe(0.25);
    });
  });

  it("stops counting ledger entries once they are older than the rolling day", async () => {
    await withTempBaseDir(async (baseDir) => {
      const spent = await Effect.gen(function* () {
        const store = yield* MemOverseerTaskStoreModule.MemOverseerTaskStore;
        const nowMs = yield* Clock.currentTimeMillis;
        yield* store.recordSpend({ atMs: nowMs - 25 * 60 * 60_000, usd: 0.5, threadId: "old" });
        yield* store.recordSpend({ atMs: nowMs - 60_000, usd: 0.2, threadId: "fresh" });
        return yield* store.totalSpentUsd();
      }).pipe(Effect.provide(storeLayer(baseDir)), Effect.runPromise);

      expect(spent).toBe(0.2);
    });
  });
});
