/**
 * The environment's single Mem thread: where the owner talks to Mem. Identity is the `memMaster`
 * flag, never a fixed thread id, so renaming or recreating the thread keeps it the same one.
 */

import { ThreadId } from "@t3tools/contracts";

export { isMemMasterThread, MEM_MASTER_THREAD_TITLE } from "@t3tools/contracts";

/** The id `MemMasterThreadService` tries first; uniqueness rests on the flag, not this id. */
export const MEM_MASTER_THREAD_ID = ThreadId.make("thread:mem-master");
