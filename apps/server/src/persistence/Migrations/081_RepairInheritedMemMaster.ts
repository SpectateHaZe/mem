import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Delegated and subagent children of Mem's thread copied its `memMaster` flag, so the sidebar card
 * and Mem's server could pick a child. Only a thread with no parent can be Mem's; drop the flag,
 * and nothing else, from every other thread.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_remove(payload_json, '$.memMaster')
    WHERE json_extract(payload_json, '$.memMaster') = 1
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
  `;
});
