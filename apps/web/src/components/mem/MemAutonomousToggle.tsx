import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";

import { useEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Switch } from "../ui/switch";
import { MemAutonomousStatus } from "./MemAutonomousStatus";

/** Autonomous mode's on/off, shown under Mem's sidebar card while Mem's chat is open. */
export function MemAutonomousToggle({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, "Autonomous mode");
  const mem = environment?.serverConfig?.settings.mem;
  if (mem === undefined) return null;
  return (
    <div className="flex flex-col gap-1 px-2.5 pt-2">
      <label className="flex cursor-pointer items-center justify-between gap-2 text-xs font-medium text-sidebar-foreground">
        Autonomous mode
        <Switch
          checked={mem.autonomous}
          disabled={!canWrite}
          aria-label="Autonomous mode"
          onCheckedChange={(checked) =>
            void update({
              environmentId,
              // Autonomous needs the overseer on, so switching it on turns both on.
              input: {
                patch: {
                  mem: checked
                    ? { ...mem, autonomous: true, enabled: true }
                    : { ...mem, autonomous: false },
                },
              },
            })
          }
        />
      </label>
      {mem.autonomous ? <MemAutonomousStatus environmentId={environmentId} /> : null}
    </div>
  );
}
