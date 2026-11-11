import type { ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  buildQualityGatePrompt,
  parseQualityGateVerdict,
  type QualityGatePromptInput,
  type QualityGateResult,
} from "./MemQualityGate.ts";

/** A hung reviewer must not wedge the overseer; five minutes is the longest rubric pass we pay for. */
const REVIEW_TIMEOUT_MS = 300_000;

/**
 * The one free-form text op is `generateTranscriptionPostProcessing`, whose structured output is a
 * single string field. The reply is asked for by field name so the envelope does not restyle it.
 */
const REPLY_ENVELOPE_NOTE = `Return the entire review verbatim inside the "transcription" string field, preserving every heading, verdict line, and blank line. Do not summarise it and do not add commentary.`;

export class MemReviewError extends Schema.TaggedError<MemReviewError>()("MemReviewError", {
  stage: Schema.Literals(["run-prompt", "timeout"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `The quality review could not run: ${this.detail}`;
  }
}

export interface MemReviewPromptRequest {
  /** Already fully substituted; the runner never edits the rubric. */
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
}

export type MemReviewPromptRunner = (
  request: MemReviewPromptRequest,
) => Effect.Effect<{ readonly text: string }, MemReviewError>;

export interface MemReviewInput extends QualityGatePromptInput {
  readonly modelSelection: ModelSelection;
}

export class MemReviewer extends Context.Service<
  MemReviewer,
  {
    /** Never fails on a bad reply: a garbled one parses to `usable: false`, which is rework. */
    readonly review: (input: MemReviewInput) => Effect.Effect<QualityGateResult, MemReviewError>;
  }
>()("t3/overseer/MemReviewer") {}

export interface MemReviewerOptions {
  readonly runPrompt: MemReviewPromptRunner;
  readonly timeoutMillis?: number | undefined;
}

export const makeMemReviewer = (options: MemReviewerOptions): MemReviewer["Service"] => {
  const timeoutMillis = options.timeoutMillis ?? REVIEW_TIMEOUT_MS;

  const review: MemReviewer["Service"]["review"] = Effect.fn("MemReviewer.review")(
    function* (input) {
      const { text } = yield* options
        .runPrompt({ prompt: buildQualityGatePrompt(input), modelSelection: input.modelSelection })
        .pipe(
          Effect.timeoutOption(Duration.millis(timeoutMillis)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new MemReviewError({
                    stage: "timeout",
                    detail: `the reviewer did not answer within ${timeoutMillis}ms.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          // A provider dying inside its own runtime is still a review that did not run.
          Effect.catchDefect((cause) =>
            Effect.fail(
              new MemReviewError({
                stage: "run-prompt",
                detail: "the reviewer model call failed.",
                cause,
              }),
            ),
          ),
        );
      return parseQualityGateVerdict(text);
    },
  );

  return MemReviewer.of({ review });
};

const providerRunner =
  (
    textGeneration: TextGeneration.TextGeneration["Service"],
    fileSystem: FileSystem.FileSystem,
  ): MemReviewPromptRunner =>
  (request) =>
    Effect.gen(function* () {
      // Providers run in a working directory; a review must never read the checkout under test.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mem-review-" }).pipe(
        Effect.mapError(
          (cause) =>
            new MemReviewError({
              stage: "run-prompt",
              detail: "the reviewer could not get a scratch directory.",
              cause,
            }),
        ),
      );
      const generated = yield* textGeneration
        .generateTranscriptionPostProcessing({
          cwd,
          prompt: `${request.prompt}\n\n${REPLY_ENVELOPE_NOTE}`,
          modelSelection: request.modelSelection,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MemReviewError({
                stage: "run-prompt",
                detail: "the reviewer model call failed.",
                cause,
              }),
          ),
        );
      return { text: generated.transcription };
    }).pipe(Effect.scoped);

const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  return makeMemReviewer({ runPrompt: providerRunner(textGeneration, fileSystem) });
});

export const layer = Layer.effect(MemReviewer, make);
