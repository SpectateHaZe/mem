import { MemApprovalQueue } from "../mem/MemApprovalQueue";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";

/**
 * Its own section above the Mem settings because a queued deletion is the one thing Mem cannot do
 * without the owner, and it never expires.
 */
export function MemApprovalsSection() {
  const { environment } = useSettingsScope();
  return (
    <SettingsSection
      id={searchableSetting("mem-approvals").id}
      title="Waiting for your answer"
      titleAction={
        <span className="text-muted-foreground text-xs">
          Mem will not send a destructive deletion on its own.
        </span>
      }
    >
      <MemApprovalQueue environmentId={environment?.environmentId ?? null} />
    </SettingsSection>
  );
}
