import type { EnvironmentId, GoalQueue } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { hasDesktopNotifications } from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { queueAlerts } from "./roomLogic";

function QueueWatcher({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(serverEnvironment.queueLive({ environmentId, input: {} }));
  const previous = useRef<GoalQueue | undefined>(undefined);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- toasts and OS notifications live outside React.
  useEffect(() => {
    if (data === undefined || data === null) return;
    const alerts = queueAlerts(previous.current, data);
    previous.current = data;
    const useDesktop =
      document.hidden &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      hasDesktopNotifications(getClientSettings().notificationMode);
    for (const alert of alerts) {
      toastManager.add(alert);
      if (!useDesktop) continue;
      try {
        const notification = new Notification(alert.title, {
          body: alert.description,
          silent: true,
        });
        notification.addEventListener("click", () => window.focus());
      } catch {
        // Some platforms refuse page-created notifications; the toast already showed.
      }
    }
  }, [data]);

  return null;
}

export function QueueNotifications() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <QueueWatcher environmentId={environmentId} />;
}
