import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const createdAt = "2026-11-01T00:00:00.000Z";

const payload = (id: string, parentThreadId: string | null, memMaster: boolean) => ({
  id,
  projectId: "project-1",
  title: id,
  creationSource: parentThreadId === null ? "server" : "mcp",
  lineage: {
    parentThreadId,
    relationshipToParent: parentThreadId === null ? null : "subagent",
    rootThreadId: "thread:mem-master",
  },
  lifecycle: "in_progress",
  ...(memMaster ? { memMaster: true } : {}),
});

layer("081_RepairInheritedMemMaster", (it) => {
  it.effect("drops the Mem flag from children of Mem's thread and nothing else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      const threads = [
        payload("thread:mem-master", null, true),
        payload("thread:delegated-task:command-1", "thread:mem-master", true),
        payload("thread:provider:claudeAgent:native-thread:1", "thread:mem-master", true),
        payload("thread-ordinary", null, false),
      ];
      for (const thread of threads) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${thread.id}, 'project-1', ${thread.id}, 'claudeAgent', 'full-access', 'default',
            ${createdAt}, ${createdAt}, ${JSON.stringify(thread)}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 81 });

      const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
      `;
      const after = new Map(rows.map((row) => [row.thread_id, JSON.parse(row.payload_json)]));
      for (const thread of threads) {
        const { memMaster: _memMaster, ...rest } = thread as typeof thread & { memMaster?: true };
        const expected =
          thread.id === "thread:mem-master" ? thread : (rest as Record<string, unknown>);
        assert.deepStrictEqual(after.get(thread.id), expected);
      }
    }),
  );
});
