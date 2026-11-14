import {
  type ComputerActInput,
  HandActResult,
  HandError,
  type HandRunInput,
  HandRunResult,
  HandScreenshot,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as HandHelper from "../../../lendAHand/HandHelper.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HandScreenshotToolkit, HandToolkit } from "./tools.ts";

const decodeRun = Schema.decodeUnknownEffect(HandRunResult);
const decodeAct = Schema.decodeUnknownEffect(HandActResult);
const decodeScreenshot = Schema.decodeUnknownEffect(HandScreenshot);

const unexpected = () => new HandError({ message: "The other PC sent an unexpected reply." });

/** Forwards to the PC this calling thread was connected to; any other thread is refused there. */
const forward = Effect.fn("HandToolkit.forward")(function* <A, E>(
  route: "run" | "screenshot" | "act",
  body: unknown,
  decode: (json: unknown) => Effect.Effect<A, E>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only a chat connected with Lend a hand can use this.",
    });
  }
  const helper = yield* HandHelper.HandHelper;
  return yield* helper.call(scope.thread.threadId, route, body).pipe(
    Effect.flatMap((json) => decode(json).pipe(Effect.mapError(unexpected))),
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "capability_denied", message: error.message }),
    ),
  );
});

const hand_run = McpToolAccess.actsAsCaller((input: HandRunInput) =>
  forward("run", input, decodeRun),
);

const hand_act = McpToolAccess.actsAsCaller((input: ComputerActInput) =>
  forward("act", input, decodeAct),
);

const hand_screenshot = McpToolAccess.readsAsCaller(() =>
  forward("screenshot", {}, decodeScreenshot).pipe(
    Effect.map((shot) => ({ screenshot: { mimeType: "image/png" as const, ...shot } })),
  ),
);

export const layer = McpToolAccess.toLayer(HandToolkit, { hand_run, hand_act });
export const layerScreenshot = McpToolAccess.toLayer(HandScreenshotToolkit, { hand_screenshot });
