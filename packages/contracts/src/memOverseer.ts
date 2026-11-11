import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

/**
 * The bar Mem holds a finished session to before it accepts the work.
 *
 * Editable from Settings, so the criteria stay the owner's and not the model's. Placeholders the
 * overseer fills before sending this to the reviewer: `{{task}}`, `{{acceptance}}`, `{{changes}}`,
 * `{{evidence}}`.
 */
export const DEFAULT_MEM_QUALITY_PROMPT = `You are reviewing work you did not write. You are a senior software developer deciding whether this ships or goes back for rework. You are not the author's friend, and you are not looking for reasons to say yes.

THE TASK THE SESSION WAS GIVEN
{{task}}

WHAT "DONE" MEANS FOR THIS TASK
{{acceptance}}

WHAT CHANGED
{{changes}}

EVIDENCE THE SESSION PROVIDED
{{evidence}}

Judge only against the acceptance criteria and the evidence. Do not invent requirements, and do not accept a claim you cannot see supported.

REJECT if any of these are present. Each is a defect, not a style preference.

1. Unverified claims. The session says tests pass, a build succeeds, or a page renders, and the evidence does not show it. Claiming verification that was not run is the single worst defect here.
2. Stubs standing in for work. TODO, "implement later", a function that returns a placeholder, a handler wired to nothing, an empty catch, a comment describing what the code would do.
3. Swallowed failure. Errors caught and ignored, defaults that hide a broken state, a spinner that spins on a request that already failed, a retry that cannot succeed.
4. Tests that cannot fail. Assertions on nothing, the unit under test mocked out, a test that only proves a function was called, a snapshot nobody read.
5. Unbounded or unsafe edges. Loops over outside data with no ceiling, unbounded buffers, a length trusted from a request, a parse that throws on malformed input where the rest of the codebase fails closed.
6. Copy-paste instead of reuse. Duplicated logic where the repo already has the helper, a second implementation of something that exists one directory over, a fork of a pattern the neighbours do differently.
7. Ignoring the codebase's conventions. Names, file layout, error style, or test style that fight the surrounding code, so the change reads as foreign in its own repository.
8. Dead weight. Commented-out code, unused exports, debug logging left in, files touched for no reason, scope creep beyond the task.
9. Hardcoded values that belong in config. Paths, ports, addresses, keys, timings, or offsets inlined where the repo keeps them in one named place.
10. Tests missing where the change can break. Logic, state, persistence, protocol, and parsing changes without a test that fails on the old behaviour. Visual nits do not need one; a race condition does.
11. UI that lies. A control with no effect, a disabled state with no reason, a layout that shifts on load, an animation that repaints forever.
12. Shallow work in place of the task. The task asked for a capability and the session delivered a demo, an overview, a plan, or a "shape you can fill in".

ACCEPT only when the evidence you were shown supports every claim, the acceptance criteria are met literally, and a maintainer could merge this without asking what the author meant.

OUTPUT EXACTLY THIS SHAPE

VERDICT: ACCEPT or REJECT

FINDINGS:
- one line per defect: severity (blocking or minor), file:line, what is wrong, and what the fix must do
- write "none" when there are no findings

REASONING:
- two to four sentences on why this verdict, in the voice of a senior reviewing a pull request

NEXT INSTRUCTION:
- when REJECT: the exact message to send back to the session, imperative, concrete, naming the files and the required change. No praise, no hedging, no restating the task. If the same defect came back twice, say what it did wrong twice and require a different approach.
- when ACCEPT: one sentence naming what was verified, for the owner's morning summary.`;

export const MemOverseerSettings = Schema.Struct({
  /** Mem only acts while this is on. The switch exists so a long lunch cannot hand over the repo. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Hard stop for money. Reaching it parks every claimed task and summarises; it never overshoots. */
  spendingCapUsd: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  /** Folder Mem creates new project checkouts in when no existing session fits the task. */
  spawnDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Idle time before Mem treats the owner as away and takes control. */
  idleThresholdMinutes: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  qualityPrompt: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MEM_QUALITY_PROMPT)),
  ),
  /** Screenshot the finished work for the completion summary. Costs a computer-use pass. */
  summaryWithImages: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type MemOverseerSettings = typeof MemOverseerSettings.Type;

export const DEFAULT_MEM_OVERSEER_SETTINGS: MemOverseerSettings = Schema.decodeSync(
  MemOverseerSettings,
)({});

/** An instruction Mem would not send on its own, waiting for a human answer. */
export const MemPendingApproval = Schema.Struct({
  approvalId: Schema.String,
  threadId: Schema.String,
  /** Never logged: the instruction is a message body. */
  instruction: Schema.String,
  createdAtMs: Schema.Number,
  evidenceFingerprint: Schema.String,
  /** True for a destructive deletion, which never expires; only these queue today. */
  blocking: Schema.Boolean,
});
export type MemPendingApproval = typeof MemPendingApproval.Type;

export const MemPendingApprovalsResult = Schema.Struct({
  approvals: Schema.Array(MemPendingApproval),
});
export type MemPendingApprovalsResult = typeof MemPendingApprovalsResult.Type;

export const MemAnswerApprovalInput = Schema.Struct({
  threadId: Schema.String,
  approvalId: Schema.String,
  decision: Schema.Literals(["approve", "deny"]),
});
export type MemAnswerApprovalInput = typeof MemAnswerApprovalInput.Type;

/** `missing` means the approval was already answered or expired; `failed` means the send failed. */
export const MemAnswerApprovalResult = Schema.Struct({
  outcome: Schema.Literals(["sent", "denied", "missing", "failed"]),
});
export type MemAnswerApprovalResult = typeof MemAnswerApprovalResult.Type;
