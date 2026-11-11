/**
 * Owner-idle tracking for the Mem overseer: activity is reported in, never polled, and the clock is
 * persisted so a crash or an app update cannot reset the countdown or hand the machine over.
 */

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

export type MemIdleState = {
  readonly lastActivityAtMs: number;
  readonly awaySinceMs: number | null;
};

interface IdleVerdict {
  readonly ownerAway: boolean;
  readonly awayForMs: number;
}

const MINUTE_MS = 60_000;

/** A stale or out-of-order report is ignored, and any report ends the current away episode. */
export const recordActivity = (state: MemIdleState, nowMs: number): MemIdleState => ({
  lastActivityAtMs:
    Number.isFinite(nowMs) && nowMs > state.lastActivityAtMs ? nowMs : state.lastActivityAtMs,
  awaySinceMs: null,
});

export const evaluateIdle = (
  state: MemIdleState,
  nowMs: number,
  thresholdMinutes: number,
): IdleVerdict => {
  // A zero, negative, or non-finite threshold is unconfigured, so the owner is never away.
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) {
    return { ownerAway: false, awayForMs: 0 };
  }
  const awayForMs = nowMs - state.lastActivityAtMs;
  // A clock reading behind the last report is skew, not idleness.
  if (!Number.isFinite(awayForMs) || awayForMs < 0) {
    return { ownerAway: false, awayForMs: 0 };
  }
  return { ownerAway: awayForMs >= thresholdMinutes * MINUTE_MS, awayForMs };
};

export const MEM_IDLE_STATE_FILE_NAME = "mem-idle.json";

/** Two numbers and nothing else, so a corrupt or hand-edited file fails the decode. */
const PersistedMemIdleState = Schema.Struct({
  lastActivityAtMs: Schema.Finite,
  awaySinceMs: Schema.NullOr(Schema.Finite),
});

const decodePersistedMemIdleState = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedMemIdleState),
);

export class MemIdleTracker extends Context.Service<
  MemIdleTracker,
  {
    readonly recordActivity: () => Effect.Effect<void>;
    readonly snapshot: () => Effect.Effect<MemIdleState>;
    readonly isOwnerAway: (thresholdMinutes: number) => Effect.Effect<boolean>;
  }
>()("t3/overseer/MemIdleTracker") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const statePath = path.join(config.stateDir, MEM_IDLE_STATE_FILE_NAME);

  const persist = (next: MemIdleState) =>
    writeFileStringAtomically({
      filePath: statePath,
      contents: `${JSON.stringify(next)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      // Best effort: the in-memory clock stays authoritative for this process.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not persist the Mem idle state.", { cause }),
      ),
    );

  const load = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.orElseSucceed(() => ""));
    const decoded = decodePersistedMemIdleState(raw.trim());
    // No usable file means the countdown starts now; a fresh install is not an absent owner.
    return Option.getOrElse(decoded, (): MemIdleState => ({
      lastActivityAtMs: nowMs,
      awaySinceMs: null,
    }));
  });

  const state = yield* Ref.make(yield* load);
  // One permit covers the ref update and the write, so a slower write cannot land last.
  const writeLock = yield* Semaphore.make(1);

  const recordActivityNow = Effect.fn("MemIdleTracker.recordActivity")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* writeLock.withPermit(
      Effect.gen(function* () {
        const next = yield* Ref.modify(state, (current) => {
          const updated = recordActivity(current, nowMs);
          return [updated, updated] as const;
        });
        yield* persist(next);
      }),
    );
  });

  const snapshot = Effect.fn("MemIdleTracker.snapshot")(function* () {
    return yield* Ref.get(state);
  });

  const isOwnerAway = Effect.fn("MemIdleTracker.isOwnerAway")(function* (thresholdMinutes: number) {
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const verdict = evaluateIdle(current, nowMs, thresholdMinutes);
        // Stamp the first away observation once; callers can then report a duration, not a poll.
        const awaySinceMs = verdict.ownerAway ? (current.awaySinceMs ?? nowMs) : null;
        if (awaySinceMs !== current.awaySinceMs) {
          const next = { lastActivityAtMs: current.lastActivityAtMs, awaySinceMs };
          yield* Ref.set(state, next);
          yield* persist(next);
        }
        return verdict.ownerAway;
      }),
    );
  });

  return { recordActivity: recordActivityNow, snapshot, isOwnerAway } as const;
});

export const layer = Layer.effect(MemIdleTracker, make);
