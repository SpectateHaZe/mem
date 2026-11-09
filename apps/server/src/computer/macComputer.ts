// @effect-diagnostics nodeBuiltinImport:off -- The macOS platform boundary spawns built-in capture tools and reads their temporary PNG output.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ComputerActInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as Effect from "effect/Effect";

import {
  MAC_INFO_ARGUMENTS,
  MAC_MEASURE_ARGUMENTS,
  MAC_SCREENCAPTURE,
  MAC_SIPS,
  interpretMacAction,
  macActPlan,
  macPointFactor,
  macResizePlan,
  macSipsArguments,
  parseMacInfo,
  pngDimensions,
} from "./macScripts.ts";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export type MacComputerErrorCode = "capability_denied" | "invalid_request" | "orchestration_error";

export class MacComputerError extends Schema.TaggedError<MacComputerError>()("MacComputerError", {
  code: Schema.Literals(["capability_denied", "invalid_request", "orchestration_error"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const macPermissionMessages = {
  "screen-recording":
    "macOS needs Screen Recording permission to see the screen. In System Settings > Privacy & Security > Screen Recording, allow the app Mem runs from, then restart it.",
  accessibility:
    "macOS needs Accessibility permission to control the mouse and keyboard. In System Settings > Privacy & Security > Accessibility, allow the app Mem runs from, then restart it.",
} as const;

/** Same discipline as the Windows runner: argv only, one killable child, no shell. */
const runMacCommand = (argv: readonly string[], env?: Readonly<Record<string, string>>) =>
  Effect.callback<string, MacComputerError>((resume) => {
    const child = NodeChildProcess.execFile(
      argv[0]!,
      argv.slice(1) as string[],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: env === undefined ? process.env : { ...process.env, ...env },
      },
      (error, stdout) =>
        resume(
          error === null
            ? Effect.succeed(stdout.toString())
            : Effect.fail(
                new MacComputerError({
                  code: "orchestration_error",
                  detail: `The macOS desktop command failed: ${error.message}`,
                }),
              ),
        ),
    );
    return Effect.sync(() => child.kill());
  });

const readScreenInfo = Effect.fn("MacComputer.readScreenInfo")(function* (
  measure: readonly string[],
) {
  const outcome = parseMacInfo(yield* runMacCommand(measure));
  if (outcome === undefined) {
    return yield* new MacComputerError({
      code: "orchestration_error",
      detail:
        "macOS didn't report its screen size, so screenshot coordinates can't be scaled to real points.",
    });
  }
  if (outcome.kind === "permission") {
    return yield* new MacComputerError({
      code: "capability_denied",
      detail: macPermissionMessages[outcome.permission],
    });
  }
  if (outcome.kind === "unsupported") {
    return yield* new MacComputerError({
      code: "orchestration_error",
      detail: `macOS is missing ${outcome.what}, which computer use needs to measure the screen.`,
    });
  }
  return outcome.info;
});

/** Trusted to read the screen: preflights Screen Recording before any capture starts. */
const screenInfo = readScreenInfo(MAC_INFO_ARGUMENTS);

const readFileOr = (path: string, message: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.readFile(path),
    catch: () => new MacComputerError({ code: "orchestration_error", detail: message }),
  });

/** `screencapture` on the main display, then the same shrink-toward-1280-window as Windows. */
export const macScreenshot: Effect.Effect<
  { readonly width: number; readonly height: number; readonly data: string },
  MacComputerError
> = Effect.scoped(
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mem-computer-")),
        catch: () =>
          new MacComputerError({
            code: "orchestration_error",
            detail: "Couldn't create a temporary folder for the screenshot.",
          }),
      }),
      (directory) =>
        Effect.tryPromise({
          try: () => NodeFSP.rm(directory, { recursive: true, force: true }),
          catch: () =>
            new MacComputerError({
              code: "orchestration_error",
              detail: "Couldn't clean up the temporary screenshot folder.",
            }),
        }).pipe(Effect.orElseSucceed(() => undefined)),
    );
    yield* screenInfo;
    const capturePath = NodePath.join(dir, "capture.png");
    yield* runMacCommand([MAC_SCREENCAPTURE, "-x", "-t", "png", capturePath]);
    const captured = yield* readFileOr(
      capturePath,
      "macOS left no readable screenshot file behind.",
    );
    const capturedSize = pngDimensions(captured);
    if (capturedSize === undefined) {
      return yield* new MacComputerError({
        code: "orchestration_error",
        detail: "macOS didn't return a valid screenshot.",
      });
    }
    let png = captured;
    let { width, height } = capturedSize;
    const plan = macResizePlan(width, height);
    if (plan.scale < 1) {
      const resizedPath = NodePath.join(dir, "resized.png");
      yield* runMacCommand([
        MAC_SIPS,
        ...macSipsArguments(plan.height, plan.width, capturePath, resizedPath),
      ]);
      png = yield* readFileOr(resizedPath, "macOS left no readable screenshot file behind.");
      const resized = pngDimensions(png);
      if (resized === undefined) {
        return yield* new MacComputerError({
          code: "orchestration_error",
          detail: "macOS didn't return a valid screenshot.",
        });
      }
      width = resized.width;
      height = resized.height;
    }
    return { width, height, data: png.toString("base64") };
  }),
);

/**
 * Mouse coordinates need the live display scale, but typing and key presses need neither scale nor
 * Screen Recording, so those actions skip the measurement probe entirely.
 */
export const macAct = Effect.fn("MacComputer.act")(function* (input: ComputerActInput) {
  const scalesInput = input.action !== "type" && input.action !== "key";
  const factor = scalesInput ? macPointFactor(yield* readScreenInfo(MAC_MEASURE_ARGUMENTS)) : 1;
  const plan = macActPlan(input, factor);
  if (typeof plan === "string") {
    return yield* new MacComputerError({ code: "invalid_request", detail: plan });
  }
  const outcome = interpretMacAction(yield* runMacCommand(plan.argv, plan.env));
  if (outcome.kind === "ok") return { ok: true };
  if (outcome.kind === "permission") {
    return yield* new MacComputerError({
      code: "capability_denied",
      detail: macPermissionMessages[outcome.permission],
    });
  }
  if (outcome.kind === "unsupported") {
    return yield* new MacComputerError({
      code: "orchestration_error",
      detail: `macOS gave computer use no Quartz event bridge (${outcome.what}); mouse and keyboard actions are unavailable here.`,
    });
  }
  return yield* new MacComputerError({
    code: "orchestration_error",
    detail: "macOS couldn't perform the desktop action.",
  });
});
