import type { ComputerActInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { computerUseRefusal } from "../../../computer/computerScripts.ts";
import * as ComputerUseActivity from "../../../computer/ComputerUseActivity.ts";
import { captureScreen, desktopFailure as failure, performAct } from "../../../computer/desktop.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { ComputerActToolkit, ComputerScreenshotToolkit } from "./tools.ts";

const requireAllowed = Effect.fn("ComputerToolkit.requireAllowed")(function* (acting: boolean) {
  const { computerUseMode } = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => failure("Couldn't read Mem's settings.", "orchestration_error")),
  );
  const refusal = computerUseRefusal(computerUseMode, yield* HostProcess.Platform, acting);
  if (refusal !== undefined) return yield* failure(refusal, "capability_denied");
  // These tools skip the provider's approval prompts, so a supervised thread may not use them.
  const { limits, caller } = yield* loadCaller();
  if (limits.runtimeMode !== "full-access") {
    return yield* failure("Only full-access threads may use the desktop.", "capability_denied");
  }
  return caller === undefined ? undefined : { threadId: caller.id, projectId: caller.projectId };
});

const computer_screenshot = McpToolAccess.readsAsCaller(() =>
  Effect.gen(function* () {
    const caller = yield* requireAllowed(false);
    const activity = yield* ComputerUseActivity.ComputerUseActivity;
    const screenshot = yield* captureScreen;
    yield* activity.screenshot(caller, screenshot);
    return { screenshot: { mimeType: "image/png" as const, ...screenshot } };
  }),
);

const computer_act = McpToolAccess.actsAsCaller((input: ComputerActInput) =>
  Effect.gen(function* () {
    const caller = yield* requireAllowed(true);
    // Shown before the action runs, so the glow and marker lead the real cursor.
    yield* (yield* ComputerUseActivity.ComputerUseActivity).act(caller, input);
    return yield* performAct(input);
  }),
);

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});
export const layerAct = McpToolAccess.toLayer(ComputerActToolkit, { computer_act });
