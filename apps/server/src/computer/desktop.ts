// @effect-diagnostics nodeBuiltinImport:off -- one short-lived process needing exit status and a kill timeout.
import * as NodeChildProcess from "node:child_process";

import { type ComputerActInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { actScript, parseScreenshot, SCREENSHOT_SCRIPT } from "./computerScripts.ts";
import { macAct, macScreenshot, MacComputerError } from "./macComputer.ts";

/** This machine's screen and input, shared by computer use and Lend a Hand. */

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export const desktopFailure = (
  message: string,
  code: "capability_denied" | "invalid_request" | "orchestration_error",
) => new OrchestratorMcpFailure({ code, message });

const isMacComputerError = Schema.is(MacComputerError);

const macFailure = (error: unknown) =>
  isMacComputerError(error)
    ? desktopFailure(error.detail, error.code)
    : desktopFailure("The macOS desktop command failed.", "orchestration_error");

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
            : Effect.fail(desktopFailure("The desktop command failed.", "orchestration_error")),
        ),
    );
    return Effect.sync(() => child.kill());
  });

/** The primary display as a base64 PNG, scaled the way `performAct` expects coordinates. */
export const captureScreen = Effect.gen(function* () {
  const screenshot =
    (yield* HostProcess.Platform) === "darwin"
      ? yield* Effect.mapError(macScreenshot, macFailure)
      : parseScreenshot(yield* runPowerShell(SCREENSHOT_SCRIPT));
  if (screenshot === undefined) {
    return yield* desktopFailure("Couldn't read the screen.", "orchestration_error");
  }
  return screenshot;
});

export const performAct = Effect.fn("desktop.performAct")(function* (input: ComputerActInput) {
  if ((yield* HostProcess.Platform) === "darwin") {
    return yield* Effect.mapError(macAct(input), macFailure);
  }
  const action = actScript(input);
  if (typeof action === "string") return yield* desktopFailure(action, "invalid_request");
  yield* runPowerShell(action.script, action.keys);
  return { ok: true };
});
