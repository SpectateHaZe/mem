import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { distinctBySpend } from "./roomListUpdates.ts";

const snapshot = (spentTodayUsd: number) => ({ rooms: [] as ReadonlyArray<string>, spentTodayUsd });

const spends = (values: ReadonlyArray<number>) =>
  Stream.fromIterable(values.map(snapshot)).pipe(
    distinctBySpend,
    Stream.runCollect,
    Effect.map((chunk) => [...chunk].map((entry) => entry.spentTodayUsd)),
  );

it.effect("sends only the snapshots whose spend figure changed", () =>
  Effect.gen(function* () {
    expect(yield* spends([0, 0, 1.5, 1.5, 2])).toEqual([0, 1.5, 2]);
  }),
);

it.effect("an idle stream still sends its first snapshot once", () =>
  Effect.gen(function* () {
    expect(yield* spends([3, 3, 3])).toEqual([3]);
  }),
);
