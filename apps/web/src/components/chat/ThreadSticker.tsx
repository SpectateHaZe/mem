import { useEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useStickerImage } from "../../hooks/useStickerImage";
import {
  stickerSettingKey,
  stickerSlotForTurnState,
  type ThreadStickerAttention,
} from "../../lib/stickers";

/**
 * The state machine itself (which slot answers which turn state) lives in
 * stickerSlotForTurnState so it can be tested without the view. "Finished"
 * here is a transition: the chat is free and was working on the same thread.
 */
export function ThreadSticker(props: {
  readonly threadKey: string;
  readonly isWorking: boolean;
  readonly awaitingUser: ThreadStickerAttention;
  readonly className?: string;
}) {
  const [turnRecentlyCompleted, setTurnRecentlyCompleted] = useState(false);
  const wasWorkingRef = useRef(false);
  const slot = stickerSlotForTurnState({
    isWorking: props.isWorking,
    awaitingUser: props.awaitingUser,
    // A whole-thread switch lands in the effect below, so the previous turn
    // does not make the next thread claim finished.
    turnRecentlyCompleted,
  });
  // The finished sticker marks the working → free transition, which React state
  // cannot derive from the flags the chat view passes down.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-derives the turn's last transition on every working flag change
  useEffect(() => {
    if (props.isWorking) {
      wasWorkingRef.current = true;
      return;
    }
    if (wasWorkingRef.current) {
      wasWorkingRef.current = false;
      setTurnRecentlyCompleted(true);
    }
  }, [props.isWorking]);
  const reset = useRef(props.threadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forgets the previous thread's transition when the route changes
  useEffect(() => {
    if (reset.current !== props.threadKey) {
      reset.current = props.threadKey;
      wasWorkingRef.current = false;
      setTurnRecentlyCompleted(false);
    }
  }, [props.threadKey]);

  const nameKey = slot === null ? "stickerWorkingName" : stickerSettingKey(slot);
  const configured = useClientSettings((settings) => settings[nameKey].length > 0);
  const image = useStickerImage(slot ?? "working");

  if (slot === null || !configured) return null;

  return (
    <div
      aria-hidden="true"
      className={cn(
        // Only wide windows have margin next to the max-width chat lane; below
        // xl the sticker stays out of the layout entirely.
        "pointer-events-none select-none absolute right-3 bottom-2 z-0 hidden xl:block",
        props.className,
      )}
    >
      {image === null ? null : (
        <img alt="" className="max-h-16 max-w-24 object-contain" draggable={false} src={image} />
      )}
    </div>
  );
}
