import { BUILTIN_STICKER_SRC } from "~/lib/memStickers";
import { cn } from "~/lib/utils";

/**
 * The Mem master thread as its own card above both sidebar lists. It is not a
 * thread row: it never sorts, drags, or joins a list.
 */
export function MemMasterCard(props: {
  readonly isActive: boolean;
  readonly isWatching: boolean;
  readonly statusLine: string;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={props.isActive ? "page" : undefined}
      aria-label={`Open the Mem thread, ${props.statusLine}`}
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
        <span className="truncate text-sm font-semibold text-sidebar-foreground">Mem</span>
        <span className="truncate text-xs text-sidebar-muted-foreground">{props.statusLine}</span>
      </span>
    </button>
  );
}
