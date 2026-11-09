import { DownloadIcon, XIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  type MacManualUpdateNotice,
  getMacManualUpdateNotice,
  macManualUpdateDismissedKey,
} from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { useDesktopUpdateState } from "../../state/desktopUpdate";

const MacUpdateDismissalSchema = Schema.Boolean;

export function SidebarUpdateMacNotice() {
  return isElectron ? <SidebarUpdateMacNoticeContent /> : null;
}

function SidebarUpdateMacNoticeContent() {
  const state = useDesktopUpdateState();
  const platform = typeof window !== "undefined" ? window.desktopBridge?.getClientPlatform() : null;
  const notice = getMacManualUpdateNotice(state, platform);
  const [dismissed, setDismissed] = useLocalStorage(
    macManualUpdateDismissedKey(notice?.version ?? ""),
    false,
    MacUpdateDismissalSchema,
  );

  if (!notice || dismissed) return null;

  return <MacNotice notice={notice} onDismiss={() => setDismissed(true)} />;
}

function MacNotice({
  notice,
  onDismiss,
}: {
  notice: MacManualUpdateNotice;
  onDismiss: () => void;
}) {
  return (
    <Alert variant="info">
      <DownloadIcon />
      <AlertTitle>New Mem version available</AlertTitle>
      <AlertDescription>
        Mem {notice.version} is ready. This macOS build is unsigned, so install it by downloading it
        from the release page.
      </AlertDescription>
      <AlertAction>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            if (window.desktopBridge) {
              void openDesktopUpdateReleaseNotes(window.desktopBridge, notice.releaseUrl);
            }
          }}
        >
          Download
        </Button>
        <Button
          size="icon-tiny"
          variant="ghost-muted"
          aria-label="Dismiss update notice"
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}
