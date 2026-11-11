import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import {
  makeMemReviewer,
  MemReviewError,
  MemReviewer,
  type MemReviewInput,
  type MemReviewPromptRequest,
  type MemReviewerOptions,
} from "./MemReviewer.ts";
import type { QualityGateResult } from "./MemQualityGate.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "haiku" };

const template = `TASK
{{task}}

DONE MEANS
{{acceptance}}

CHANGED
{{changes}}

EVIDENCE
{{evidence}}`;

const input: MemReviewInput = {
  template,
  task: "Add a reviewer adapter",
  acceptance: "The reply is parsed into a verdict",
  changes: "MemReviewer.ts, MemReviewer.test.ts",
  evidence: "vitest: 6 passed",
  modelSelection,
};

const reply = (text: string): MemReviewerOptions => ({ runPrompt: () => Effect.succeed({ text }) });

const runReview = (
  options: MemReviewerOptions,
  reviewInput: MemReviewInput = input,
): Promise<Exit.Exit<QualityGateResult, MemReviewError>> =>
  Effect.flatMap(MemReviewer, (reviewer) => reviewer.review(reviewInput)).pipe(
    Effect.provide(Layer.succeed(MemReviewer, makeMemReviewer(options))),
    Effect.runPromiseExit,
  );

const runFailure = async (options: MemReviewerOptions): Promise<unknown> => {
  const exit = await runReview(options);
  if (Exit.isSuccess(exit)) throw new Error("expected the review to fail");
  return Cause.squash(exit.cause);
};

const ACCEPT_REPLY = `VERDICT: ACCEPT

FINDINGS:
- none

REASONING:
- The adapter parses both verdicts and fails closed on a garbled reply.

NEXT INSTRUCTION:
- Verified the reviewer adapter against the rubric parser.`;

const REJECT_REPLY = `VERDICT: REJECT

FINDINGS:
- blocking, MemReviewer.ts:1, no timeout on the provider call; cap it with a named constant.

REASONING:
- A hung provider would wedge the overseer.

NEXT INSTRUCTION:
- Add a bounded timeout to the reviewer call in MemReviewer.ts.`;

describe("MemReviewer.review", () => {
  it("returns an accept verdict", async () => {
    const exit = await runReview(reply(ACCEPT_REPLY));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toStrictEqual({
      verdict: "accept",
      findings: [],
      reasoning: "The adapter parses both verdicts and fails closed on a garbled reply.",
      nextInstruction: "Verified the reviewer adapter against the rubric parser.",
      usable: true,
    });
  });

  it("returns a reject verdict with its findings and next instruction", async () => {
    const exit = await runReview(reply(REJECT_REPLY));
    const result = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(result).toMatchObject({
      verdict: "reject",
      usable: true,
      reasoning: "A hung provider would wedge the overseer.",
      nextInstruction: "Add a bounded timeout to the reviewer call in MemReviewer.ts.",
    });
    expect(result?.findings).toHaveLength(1);
    expect(result?.findings[0]).toContain("no timeout on the provider call");
  });

  it("parses a garbled reply as unusable instead of throwing", async () => {
    const exit = await runReview(reply("Looks good to me, ship it."));
    const result = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(result).toStrictEqual({
      verdict: "reject",
      findings: [],
      reasoning: "",
      nextInstruction: null,
      usable: false,
    });
  });

  it("substitutes the task, acceptance, changes, and evidence into the prompt", async () => {
    const requests: MemReviewPromptRequest[] = [];
    await runReview({
      runPrompt: (request) => {
        requests.push(request);
        return Effect.succeed({ text: ACCEPT_REPLY });
      },
    });

    expect(requests).toHaveLength(1);
    const prompt = requests[0]!.prompt;
    expect(prompt).toContain("Add a reviewer adapter");
    expect(prompt).toContain("The reply is parsed into a verdict");
    expect(prompt).toContain("MemReviewer.ts, MemReviewer.test.ts");
    expect(prompt).toContain("vitest: 6 passed");
    expect(prompt).not.toContain("{{task}}");
    expect(requests[0]!.modelSelection).toBe(modelSelection);
  });

  it("reports a runner failure as MemReviewError, not a defect", async () => {
    const failure = new MemReviewError({
      stage: "run-prompt",
      detail: "the reviewer model call failed.",
    });
    const error = await runFailure({ runPrompt: () => Effect.fail(failure) });
    expect(error).toStrictEqual(failure);
  });

  it("reports a provider that dies as MemReviewError", async () => {
    const error = await runFailure({ runPrompt: () => Effect.die(new Error("socket closed")) });
    expect(error).toBeInstanceOf(MemReviewError);
    expect((error as MemReviewError).stage).toBe("run-prompt");
  });

  it("times out a hung provider", async () => {
    const error = await runFailure({
      runPrompt: () => Effect.never,
      timeoutMillis: 10,
    });
    expect(error).toBeInstanceOf(MemReviewError);
    expect((error as MemReviewError).stage).toBe("timeout");
  });
});
