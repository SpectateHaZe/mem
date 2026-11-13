import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Mirrors this machine's computer use onto the desktop glow, whichever thread is driving, and
 * turns Esc on the glow into a stop. Only the local environment: the glow belongs to the machine
 * whose screen is being used.
 */
function ComputerUseOverlayWatcher({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(
    serverEnvironment.computerUseLive({ environmentId, input: {} }),
  );
  const stop = useAtomCommand(serverEnvironment.stopComputerUse, { label: "stop computer use" });
  const state = data?.state ?? "hidden";
  const pointX = data?.point?.x ?? null;
  const pointY = data?.point?.y ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the live state to the desktop's overlay windows
  useEffect(() => {
    const point = pointX === null || pointY === null ? null : { x: pointX, y: pointY };
    void window.desktopBridge?.setComputerUseOverlayState({ state, point }).catch(() => undefined);
  }, [state, pointX, pointY]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop's Esc shortcut
  useEffect(
    () =>
      window.desktopBridge?.onComputerUseStopRequest(() => {
        void stop({ environmentId, input: {} });
      }),
    [environmentId, stop],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the glow when the app view goes away
  useEffect(
    () => () => {
      void window.desktopBridge
        ?.setComputerUseOverlayState({ state: "hidden", point: null })
        .catch(() => undefined);
    },
    [],
  );

  return null;
}

export function ComputerUseOverlayBridge() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null || window.desktopBridge?.onComputerUseStopRequest === undefined) {
    return null;
  }
  return <ComputerUseOverlayWatcher environmentId={environmentId} />;
}
