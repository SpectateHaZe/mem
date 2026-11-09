// @effect-diagnostics nodeBuiltinImport:off -- one short-lived process needing exit status and a kill timeout.
import * as NodeChildProcess from "node:child_process";

import { type ObscuraFetchInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../../config.ts";
import { ensureObscura, limitContent, obscuraArgs } from "../../../obscura/obscuraBinary.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { ObscuraToolkit } from "./tools.ts";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const failure = (
  message: string,
  code: "capability_denied" | "invalid_request" | "orchestration_error",
) => new OrchestratorMcpFailure({ code, message });

const runObscura = (executable: string, args: ReadonlyArray<string>) =>
  Effect.callback<string, OrchestratorMcpFailure>((resume) => {
    const child = NodeChildProcess.execFile(
      executable,
      [...args],
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) =>
        resume(
          error === null
            ? Effect.succeed(stdout)
            : Effect.fail(
                failure(
                  `Obscura couldn't fetch the page. ${stderr.slice(0, 300)}`,
                  "orchestration_error",
                ),
              ),
        ),
    );
    return Effect.sync(() => child.kill());
  });

const obscura_fetch = McpToolAccess.readsAsCaller((input: ObscuraFetchInput) =>
  Effect.gen(function* () {
    const { obscuraEnabled } =
      yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(() => failure("Couldn't read Mem's settings.", "orchestration_error")),
      );
    if (!obscuraEnabled) {
      return yield* failure("Obscura is turned off in Mem's settings.", "capability_denied");
    }
    if ((yield* HostProcess.Platform) !== "win32") {
      return yield* failure("Obscura only works on Windows hosts for now.", "capability_denied");
    }
    // The server fetches on the caller's behalf, past the provider's approval prompts.
    const { limits } = yield* loadCaller();
    if (limits.runtimeMode !== "full-access") {
      return yield* failure("Only full-access threads may use Obscura.", "capability_denied");
    }
    const args = obscuraArgs(input);
    if (args === undefined) return yield* failure("Pass an http or https URL.", "invalid_request");
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const executable = yield* Effect.tryPromise({
      try: () => ensureObscura(stateDir),
      catch: (cause) =>
        failure(`Couldn't install Obscura: ${String(cause)}`, "orchestration_error"),
    });
    return limitContent(yield* runObscura(executable, args));
  }),
);

export const layer = McpToolAccess.toLayer(ObscuraToolkit, { obscura_fetch });
