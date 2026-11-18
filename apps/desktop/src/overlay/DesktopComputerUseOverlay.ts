import { DesktopComputerUseOverlayState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { COMPUTER_USE_OVERLAY_STATE_CHANNEL } from "../ipc/channels.ts";
import { MemComputerUseOverlay } from "./MemComputerUseOverlay.ts";

type Failure = { readonly error: unknown };

const attempt = (run: () => void): Failure | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return { error };
  }
};

export const installComputerUseOverlay = Effect.fn("desktop.ipc.installComputerUseOverlay")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    let overlay: MemComputerUseOverlay | undefined;

    const dispose = (): Failure | undefined => {
      const current = overlay;
      overlay = undefined;
      return current === undefined ? undefined : attempt(() => current.dispose());
    };

    const apply = (state: DesktopComputerUseOverlayState): Failure | undefined => {
      if (state.state === "hidden" && overlay === undefined) return undefined;
      const failure = attempt(() => {
        overlay ??= new MemComputerUseOverlay();
        overlay.setState(state);
      });
      // The overlay is decoration; a failed window must never take the app down with it.
      if (failure !== undefined) dispose();
      return failure;
    };

    // The renderer clears the overlay only as it unmounts, which a closed window never does;
    // the glow, the Esc shortcut and the overlay windows (which keep the app from quitting)
    // would outlive it.
    const watchedSenders = new Set<number>();
    const watchSender = (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) => {
      if (event === undefined || watchedSenders.has(event.sender.id)) return;
      watchedSenders.add(event.sender.id);
      event.sender.once?.("destroyed", () => {
        watchedSenders.delete(event.sender.id);
        dispose();
      });
    };

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: COMPUTER_USE_OVERLAY_STATE_CHANNEL,
        payload: DesktopComputerUseOverlayState,
        result: Schema.Void,
        handler: (state, event) =>
          Effect.sync(() => {
            if (state.state !== "hidden") watchSender(event);
            return apply(state);
          }).pipe(
            Effect.flatMap((failure) =>
              failure === undefined
                ? Effect.void
                : Effect.logWarning("Could not update the computer use overlay", failure.error),
            ),
          ),
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(dispose).pipe(
        Effect.flatMap((failure) =>
          failure === undefined
            ? Effect.void
            : Effect.logWarning("Could not dispose the computer use overlay", failure.error),
        ),
      ),
    );
  },
);
