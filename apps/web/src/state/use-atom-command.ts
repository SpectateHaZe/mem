import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useContext } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";

export interface UseAtomCommandOptions extends AtomCommandOptions {
  /** Shows a failure (other than an interrupt) as an error toast with this title. */
  readonly failureTitle?: string;
}

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | UseAtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = typeof options === "string" ? options : (options?.label ?? command.label);
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);
  const failureTitle = typeof options === "string" ? undefined : options?.failureTitle;

  return async (value: W) => {
    const result = await runAtomCommand(registry, command, value, {
      label,
      reportFailure,
      reportDefect,
    });
    if (
      failureTitle !== undefined &&
      result._tag === "Failure" &&
      !isAtomCommandInterrupted(result)
    ) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description:
            failure instanceof Error && failure.message.trim() !== ""
              ? failure.message
              : "Try again.",
        }),
      );
    }
    return result;
  };
}
