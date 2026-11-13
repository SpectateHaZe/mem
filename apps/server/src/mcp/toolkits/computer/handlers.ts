// @effect-diagnostics nodeBuiltinImport:off -- one short-lived process needing exit status and a kill timeout.
import * as NodeChildProcess from "node:child_process";

import { type ComputerActInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  actScript,
  computerUseRefusal,
  parseScreenshot,
  SCREENSHOT_SCRIPT,
} from "../../../computer/computerScripts.ts";
import { macAct, macScreenshot, MacComputerError } from "../../../computer/macComputer.ts";
import * as ComputerUseActivity from "../../../computer/ComputerUseActivity.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { ComputerActToolkit, ComputerScreenshotToolkit } from "./tools.ts";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

const failure = (
  message: string,
  code: "capability_denied" | "invalid_request" | "orchestration_error",
) => new OrchestratorMcpFailure({ code, message });

const isMacComputerError = Schema.is(MacComputerError);

const macFailure = (error: unknown) =>
  isMacComputerError(error)
    ? failure(error.detail, error.code)
    : failure("The macOS desktop command failed.", "orchestration_error");

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

const runPowerShell = (script: string, keys?: string) =>
  Effect.callback<string, OrchestratorMcpFailure>((resume) => {
    const child = NodeChildProcess.execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: TIMEOUT_MS,
        windowsHide: true,
        env: keys === undefined ? process.env : { ...process.env, MEM_KEYS: keys },
      },
      (error, stdout) =>
        resume(
          error === null
            ? Effect.succeed(stdout)
            : Effect.fail(failure("The desktop command failed.", "orchestration_error")),
        ),
    );
    return Effect.sync(() => child.kill());
  });

const computer_screenshot = McpToolAccess.readsAsCaller(() =>
  Effect.gen(function* () {
    const caller = yield* requireAllowed(false);
    const activity = yield* ComputerUseActivity.ComputerUseActivity;
    const screenshot =
      (yield* HostProcess.Platform) === "darwin"
        ? yield* Effect.mapError(macScreenshot, macFailure)
        : parseScreenshot(yield* runPowerShell(SCREENSHOT_SCRIPT));
    if (screenshot === undefined) {
      return yield* failure("Couldn't read the screen.", "orchestration_error");
    }
    yield* activity.screenshot(caller, screenshot);
    return { screenshot: { mimeType: "image/png" as const, ...screenshot } };
  }),
);

const computer_act = McpToolAccess.actsAsCaller((input: ComputerActInput) =>
  Effect.gen(function* () {
    const caller = yield* requireAllowed(true);
    // Shown before the action runs, so the glow and marker lead the real cursor.
    yield* (yield* ComputerUseActivity.ComputerUseActivity).act(caller, input);
    if ((yield* HostProcess.Platform) === "darwin") {
      return yield* Effect.mapError(macAct(input), macFailure);
    }
    const action = actScript(input);
    if (typeof action === "string") return yield* failure(action, "invalid_request");
    yield* runPowerShell(action.script, action.keys);
    return { ok: true };
  }),
);

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});
export const layerAct = McpToolAccess.toLayer(ComputerActToolkit, { computer_act });
