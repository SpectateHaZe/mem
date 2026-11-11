import { useEffect, useRef, useState } from "react";

import {
  stickerReactionDurationMs,
  stickerReactionForTurnEnd,
  type StickerReaction,
} from "../lib/stickers";

function stopTimer(timer: { current: number | null }): void {
  if (timer.current === null) return;
  window.clearTimeout(timer.current);
  timer.current = null;
}

/**
 * The reaction to the turn that just ended, cleared once its window closes.
 * The working-to-free edge is a transition React cannot derive from the flags
 * the chat view passes down, so it is read here and remembered for its moment.
 */
export function useTurnEndReaction(input: {
  readonly isWorking: boolean;
  readonly failed: boolean;
  readonly resetKey: string;
}): StickerReaction | null {
  const [reaction, setReaction] = useState<StickerReaction | null>(null);
  const wasWorking = useRef(false);
  const reset = useRef(input.resetKey);
  const timer = useRef<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forgets the previous thread's reaction when the route changes
  useEffect(() => {
    if (reset.current === input.resetKey) return;
    reset.current = input.resetKey;
    wasWorking.current = false;
    stopTimer(timer);
    setReaction(null);
  }, [input.resetKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-derives the turn's last transition on every working flag change
  useEffect(() => {
    if (input.isWorking) {
      wasWorking.current = true;
      stopTimer(timer);
      return;
    }
    if (!wasWorking.current) return;
    wasWorking.current = false;
    const next = stickerReactionForTurnEnd({ failed: input.failed });
    stopTimer(timer);
    setReaction(next);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setReaction(null);
    }, stickerReactionDurationMs(next));
  }, [input.isWorking, input.failed]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the running timer when the view unmounts
  useEffect(() => () => stopTimer(timer), []);

  // A reaction belongs to a settled turn, so live work masks the one still ticking.
  return input.isWorking ? null : reaction;
}
