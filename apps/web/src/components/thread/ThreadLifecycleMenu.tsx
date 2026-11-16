import type { ContextMenuItem, MemThreadPriority, ScopedThreadRef } from "@t3tools/contracts";
import {
  THREAD_LIFECYCLES,
  threadLifecycleOf,
  type ThreadLifecycle,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleSlashIcon,
  type LucideIcon,
} from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery, useEnvironmentQueryRefresh } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { memSetPriority, memWatchedThreadsAtom } from "../mem/memOverseer";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ThreadLifecyclePresentation {
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly className: string;
}

const THREAD_LIFECYCLE_PRESENTATION: Record<ThreadLifecycle, ThreadLifecyclePresentation> = {
  none: {
    label: "None",
    Icon: CircleIcon,
    className: "text-muted-foreground/60",
  },
  in_progress: {
    label: "In progress",
    Icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  complete: {
    label: "Complete",
    Icon: CircleCheckIcon,
    className: "text-success-foreground",
  },
  abandoned: {
    label: "Abandoned",
    Icon: CircleSlashIcon,
    className: "text-muted-foreground",
  },
};

type PriorityMenuId = `priority:${MemThreadPriority}`;
type LifecycleMenuId = ThreadLifecycle | "priority" | PriorityMenuId;

const PRIORITY_LABELS: Record<MemThreadPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** Mem serves high-priority sessions first, and near a usage limit only those. */
function buildThreadLifecycleMenuItems(
  current: ThreadLifecycle,
  priority: MemThreadPriority,
): ReadonlyArray<ContextMenuItem<LifecycleMenuId>> {
  return [
    ...THREAD_LIFECYCLES.map((lifecycle) => ({
      id: lifecycle,
      label: THREAD_LIFECYCLE_PRESENTATION[lifecycle].label,
      checked: lifecycle === current,
    })),
    {
      id: "priority" as const,
      label: "Mem priority",
      separatorBefore: true,
      children: (["high", "normal", "low"] as const).map((level) => ({
        id: `priority:${level}` as const,
        label: PRIORITY_LABELS[level],
        checked: level === priority,
      })),
    },
  ];
}

export function useThreadLifecycleMenu() {
  const setLifecycle = useOrchestrationCommand(threadEnvironment.setLifecycle, {
    reportFailure: false,
  });
  const setPriority = useAtomCommand(memSetPriority, { label: "set Mem priority" });
  const environmentId = usePrimaryEnvironmentId();
  const watchedAtom = memWatchedThreadsAtom(environmentId);
  const { data: watched } = useEnvironmentQuery(watchedAtom);
  const { refresh: refreshWatched } = useEnvironmentQueryRefresh(watchedAtom);
  const openMenu = (
    threadRef: ScopedThreadRef,
    thread: { readonly lifecycle?: ThreadLifecycle | undefined },
    position: { readonly x: number; readonly y: number },
  ) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const current = threadLifecycleOf(thread);
      // Priorities live with this environment's Mem; another environment's thread reads as normal.
      const priority =
        threadRef.environmentId === environmentId
          ? (watched?.threads.find((entry) => entry.threadId === threadRef.threadId)?.priority ??
            "normal")
          : "normal";
      const clicked = await settlePromise(() =>
        api.contextMenu.show(buildThreadLifecycleMenuItems(current, priority), position),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      if (clicked.value === current || clicked.value === "priority") return;
      if (clicked.value.startsWith("priority:")) {
        void setPriority({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            priority: clicked.value.slice("priority:".length) as MemThreadPriority,
          },
        }).then(refreshWatched);
        return;
      }
      const result = await setLifecycle({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, lifecycle: clicked.value as ThreadLifecycle },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to update thread status",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  return { openMenu };
}

export function ThreadLifecycleControl({
  lifecycle,
  canOperate,
  onOpenMenu,
}: {
  lifecycle: ThreadLifecycle;
  canOperate: boolean;
  onOpenMenu: (position: { readonly x: number; readonly y: number }) => void;
}) {
  const presentation = THREAD_LIFECYCLE_PRESENTATION[lifecycle];
  const isMarked = lifecycle !== "none";
  const label = `Thread status: ${presentation.label}`;
  const icon = <presentation.Icon aria-hidden className="size-3.5 shrink-0" />;

  if (!canOperate) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label={label}
              className={cn(
                "inline-flex shrink-0 items-center justify-center",
                presentation.className,
                !isMarked && "hidden",
              )}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={handleClick}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              presentation.className,
              isMarked
                ? "hover:opacity-80"
                : "opacity-0 group-any-hover/sidebar-row:opacity-100 group-focus-within/sidebar-row:opacity-100 focus-visible:opacity-100",
            )}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
