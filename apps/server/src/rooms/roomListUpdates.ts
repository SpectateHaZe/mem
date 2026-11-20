import * as Stream from "effect/Stream";

/**
 * Spend moves on runs, not rooms, so a room list has to be re-read on a timer. Only a changed
 * figure goes out: each snapshot carries every transcript, so an unchanged one is expensive noise.
 */
export const distinctBySpend = <A extends { readonly spentTodayUsd: number }>(
  stream: Stream.Stream<A>,
): Stream.Stream<A> =>
  stream.pipe(Stream.changesWith((left, right) => left.spentTodayUsd === right.spentTodayUsd));
