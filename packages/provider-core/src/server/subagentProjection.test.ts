import { isMemMasterThread, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeSubagentChildThread, subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});

describe("makeSubagentChildThread", () => {
  const now = DateTime.makeUnsafe("2026-11-17T00:00:00.000Z");
  const memThread = {
    id: "thread:mem-master",
    projectId: "project-1",
    title: "Mem",
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "server",
    creationSource: "server",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: "thread:mem-master",
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    memMaster: true,
  } as unknown as OrchestrationV2AppThread;

  const child = (childThreadId: string, creationSource: "mcp" | "provider") =>
    makeSubagentChildThread({
      parentThread: memThread,
      childThreadId: childThreadId as never,
      parentNodeId: "node-1" as never,
      activeProviderThreadId: null,
      providerInstanceId: memThread.providerInstanceId,
      modelSelection: memThread.modelSelection,
      title: "Portfolio site build",
      now,
      createdBy: "agent",
      creationSource,
    });

  it("never hands Mem's flag to a delegated child or a native subagent thread", () => {
    expect(isMemMasterThread(memThread)).toBe(true);
    for (const thread of [
      child("thread:delegated-task:command-1", "mcp"),
      child("thread:provider:claudeAgent:native-thread:1", "provider"),
    ]) {
      expect(thread.memMaster).toBeUndefined();
      expect(isMemMasterThread(thread)).toBe(false);
    }
  });

  it("does not read a child that already copied the flag as Mem's thread", () => {
    expect(
      isMemMasterThread({ ...child("thread:delegated-task:old", "mcp"), memMaster: true }),
    ).toBe(false);
  });
});
