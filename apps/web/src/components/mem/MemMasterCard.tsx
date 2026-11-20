import type { EnvironmentId } from "@t3tools/contracts";

import { BUILTIN_STICKER_SRC } from "~/lib/memStickers";
import { cn } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";

import { Badge } from "../ui/badge";
import { MemCardStatusLine } from "./MemAutonomousStatus";

/**
 * The Mem master thread as its own card above both sidebar lists. It is not a
 * thread row: it never sorts, drags, or joins a list.
 */
export function MemMasterCard(props: {
  readonly environmentId: EnvironmentId;
  readonly isActive: boolean;
  readonly isWatching: boolean;
  readonly statusLine: string;
  readonly onOpen: () => void;
}) {
  const autonomous =
    useEnvironment(props.environmentId)?.serverConfig?.settings.mem.autonomous === true;
  return (
    <button
      type="button"
      aria-current={props.isActive ? "page" : undefined}
      data-sidebar-row="mem-master"
      onClick={props.onOpen}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-primary/25 bg-primary/8 px-2.5 py-2 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.isActive ? "ring-1 ring-inset ring-primary/40" : "hover:bg-primary/14",
      )}
    >
      <img
        alt=""
        aria-hidden="true"
        className="size-8 shrink-0 object-contain"
        decoding="async"
        draggable={false}
        src={BUILTIN_STICKER_SRC[props.isWatching ? "mem-in-control" : "mem-happy"]}
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-sidebar-foreground">Mem</span>
          {autonomous ? (
            <Badge size="sm" variant="outline">
              Auto
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-xs text-sidebar-muted-foreground">
          <MemCardStatusLine environmentId={props.environmentId} fallback={props.statusLine} />
        </span>
      </span>
    </button>
  );
}
