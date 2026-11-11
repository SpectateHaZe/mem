import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as MemIdleTracker from "./MemIdleTracker.ts";

const MINUTE_MS = 60_000;

const IDLE: MemIdleTracker.MemIdleState = { lastActivityAtMs: 0, awaySinceMs: null };

const off = (state: MemIdleTracker.MemIdleState, nowMs: number, thresholdMinutes: number) =>
  MemIdleTracker.evaluateIdle(state, nowMs, thresholdMinutes);

describe("recordActivity", () => {
  it("adopts a newer report and clears the away marker", () => {
    expect(
      MemIdleTracker.recordActivity({ lastActivityAtMs: 1_000, awaySinceMs: 500 }, 2_000),
    ).toStrictEqual({ lastActivityAtMs: 2_000, awaySinceMs: null });
  });

  it("ignores an out-of-order report but still ends the away episode", () => {
    expect(
      MemIdleTracker.recordActivity({ lastActivityAtMs: 10_000, awaySinceMs: 9_000 }, 5_000),
    ).toStrictEqual({ lastActivityAtMs: 10_000, awaySinceMs: null });
  });

  it("ignores a non-finite report", () => {
    expect(MemIdleTracker.recordActivity(IDLE, Number.NaN)).toStrictEqual(IDLE);
  });
});

describe("evaluateIdle", () => {
  it("counts exactly the threshold as away", () => {
    expect(off(IDLE, 5 * MINUTE_MS, 5)).toStrictEqual({
      ownerAway: true,
      awayForMs: 5 * MINUTE_MS,
    });
  });

  it("is not away one millisecond before the threshold", () => {
    expect(off(IDLE, 5 * MINUTE_MS - 1, 5)).toStrictEqual({
      ownerAway: false,
      awayForMs: 5 * MINUTE_MS - 1,
    });
  });

  it("reports the elapsed idle time while away", () => {
    expect(
      off({ lastActivityAtMs: 1_000, awaySinceMs: null }, 1_000 + 90 * MINUTE_MS, 30),
    ).toStrictEqual({ ownerAway: true, awayForMs: 90 * MINUTE_MS });
  });

  it("is never away without a usable threshold", () => {
    const farPast = 1_000 * MINUTE_MS;
    for (const threshold of [
      0,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(off(IDLE, farPast, threshold)).toStrictEqual({ ownerAway: false, awayForMs: 0 });
    }
  });

  it("treats a clock reading behind the last report as not away", () => {
    expect(off({ lastActivityAtMs: 10_000, awaySinceMs: null }, 5_000, 1)).toStrictEqual({
      ownerAway: false,
      awayForMs: 0,
    });
  });
});

const runNode = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

const trackerLayer = (baseDir: string) =>
  MemIdleTracker.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

const runTracker = <A, E>(
  baseDir: string,
  program: Effect.Effect<A, E, MemIdleTracker.MemIdleTracker>,
) => program.pipe(Effect.provide(trackerLayer(baseDir)), Effect.runPromise);

// `layerTest` with a base directory and no dev URL resolves the state dir to <baseDir>/userdata.
const stateFilePath = (baseDir: string) =>
  runNode(
    Effect.map(Path.Path, (path) =>
      path.join(baseDir, "userdata", MemIdleTracker.MEM_IDLE_STATE_FILE_NAME),
    ),
  );

const withTempBaseDir = async (body: (baseDir: string) => Promise<void>) => {
  const baseDir = await runNode(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.makeTempDirectory({ prefix: "t3-mem-idle-test-" }),
    ),
  );
  try {
    await body(baseDir);
  } finally {
    await runNode(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.remove(baseDir, { recursive: true, force: true }),
      ),
    ).catch(() => undefined);
  }
};

const readStateFile = async (baseDir: string) => {
  const filePath = await stateFilePath(baseDir);
  return runNode(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(filePath)));
};

const writeStateFile = async (baseDir: string, contents: string) => {
  const filePath = await stateFilePath(baseDir);
  await runNode(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
    }),
  );
};

describe("MemIdleTracker service", () => {
  it("starts the clock at first use and persists only the two clock numbers", async () => {
    await withTempBaseDir(async (baseDir) => {
      const snapshot = await runTracker(
        baseDir,
        Effect.gen(function* () {
          const tracker = yield* MemIdleTracker.MemIdleTracker;
          yield* tracker.recordActivity();
          return yield* tracker.snapshot();
        }),
      );

      expect(snapshot.awaySinceMs).toBeNull();
      expect(Number.isFinite(snapshot.lastActivityAtMs)).toBe(true);
      expect(JSON.parse(await readStateFile(baseDir))).toStrictEqual(snapshot);
    });
  });

  it("keeps the clock across a restart", async () => {
    await withTempBaseDir(async (baseDir) => {
      const before = await runTracker(
        baseDir,
        Effect.gen(function* () {
          const tracker = yield* MemIdleTracker.MemIdleTracker;
          yield* tracker.recordActivity();
          return yield* tracker.snapshot();
        }),
      );

      const after = await runTracker(
        baseDir,
        Effect.flatMap(MemIdleTracker.MemIdleTracker, (tracker) => tracker.snapshot()),
      );

      expect(after).toStrictEqual(before);
    });
  });

  it("loads a stale clock, reports the owner away, then clears on activity", async () => {
    await withTempBaseDir(async (baseDir) => {
      const nowMs = await Clock.currentTimeMillis.pipe(Effect.runPromise);
      const seeded: MemIdleTracker.MemIdleState = {
        lastActivityAtMs: nowMs - 30 * MINUTE_MS,
        awaySinceMs: null,
      };
      await writeStateFile(baseDir, `${JSON.stringify(seeded)}\n`);

      const result = await runTracker(
        baseDir,
        Effect.gen(function* () {
          const tracker = yield* MemIdleTracker.MemIdleTracker;
          const away = yield* tracker.isOwnerAway(5);
          const whileAway = yield* tracker.snapshot();
          yield* tracker.recordActivity();
          return {
            away,
            whileAway,
            afterActivity: yield* tracker.isOwnerAway(5),
            after: yield* tracker.snapshot(),
          };
        }),
      );

      expect(result.away).toBe(true);
      expect(result.whileAway.lastActivityAtMs).toBe(seeded.lastActivityAtMs);
      expect(result.whileAway.awaySinceMs).not.toBeNull();
      expect(result.afterActivity).toBe(false);
      expect(result.after.awaySinceMs).toBeNull();
      expect(result.after.lastActivityAtMs).toBeGreaterThan(seeded.lastActivityAtMs);

      const onDisk = JSON.parse(await readStateFile(baseDir));
      expect(onDisk).toStrictEqual(result.after);
      expect(Object.keys(onDisk).toSorted()).toStrictEqual(["awaySinceMs", "lastActivityAtMs"]);
    });
  });

  it("serialises concurrent reports so the file matches memory", async () => {
    await withTempBaseDir(async (baseDir) => {
      const snapshot = await runTracker(
        baseDir,
        Effect.gen(function* () {
          const tracker = yield* MemIdleTracker.MemIdleTracker;
          yield* Effect.all(
            Array.from({ length: 8 }, () => tracker.recordActivity()),
            { concurrency: "unbounded" },
          );
          return yield* tracker.snapshot();
        }),
      );

      expect(JSON.parse(await readStateFile(baseDir))).toStrictEqual(snapshot);
    });
  });
});
