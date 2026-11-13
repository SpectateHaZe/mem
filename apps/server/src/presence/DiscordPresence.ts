// @effect-diagnostics globalTimers:off - The Discord socket owns its handshake deadline outside the Effect runtime.
import * as NodeNet from "node:net";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";

const CHECK_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
// Discord creates the first free pipe/socket, so every slot can be the live one.
const IPC_SOCKET_COUNT = 10;
const MAX_FRAME_BYTES = 1 << 20;

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const DISCORD_APP_NAME = "Mem";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export interface DiscordFrame {
  readonly op: number;
  readonly data: string;
}

/**
 * Pulls every complete frame out of a stream chunk, keeping the unfinished tail.
 * Discord coalesces and splits writes freely, so callers must feed this incrementally.
 */
export const decodeDiscordFrames = (
  buffer: Buffer,
): { readonly frames: ReadonlyArray<DiscordFrame>; readonly rest: Buffer } => {
  const frames: DiscordFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const op = buffer.readInt32LE(offset);
    const length = buffer.readInt32LE(offset + 4);
    if (length < 0 || length > MAX_FRAME_BYTES) {
      // Corrupt frame: drop it rather than buffer without bound.
      return { frames, rest: Buffer.alloc(0) };
    }
    if (buffer.length - offset - 8 < length) break;
    frames.push({
      op,
      data: buffer.subarray(offset + 8, offset + 8 + length).toString(),
    });
    offset += 8 + length;
  }
  return { frames, rest: offset === 0 ? buffer : buffer.subarray(offset) };
};

export const encodeDiscordFrame = (op: number, payload: unknown) => {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

const runtimeDirectory = (env: NodeJS.ProcessEnv) =>
  (env["XDG_RUNTIME_DIR"] ?? env["TMPDIR"] ?? env["TMP"] ?? env["TEMP"] ?? "/tmp").replace(
    /[\\/]+$/,
    "",
  ) || "/";

export const discordIpcPathCandidates = (
  platform: NodeJS.Platform | string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> =>
  platform === "win32"
    ? Array.from({ length: IPC_SOCKET_COUNT }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`)
    : (() => {
        const directory = runtimeDirectory(env);
        return Array.from(
          { length: IPC_SOCKET_COUNT },
          (_, index) => `${directory}/discord-ipc-${index}`,
        );
      })();

export interface DiscordActivity {
  readonly details: string;
  readonly timestamps: { readonly start: number };
  readonly assets?: {
    readonly large_image: string;
    readonly large_text: string;
  };
}

/**
 * Never names a project or thread: Discord shows this to the user's friends.
 * Zero live agents clears the presence instead of leaving a stale count.
 * A large image key must already be registered on the Discord application.
 */
export const presenceActivity = (
  liveAgents: number,
  startedAtMs: number,
  largeImageKey?: string,
): DiscordActivity | null => {
  const agents = Number.isFinite(liveAgents) ? Math.max(0, Math.floor(liveAgents)) : 0;
  if (agents === 0) return null;
  const activity: DiscordActivity = {
    details: agents === 1 ? "1 agent working" : `${agents} agents working`,
    timestamps: { start: Math.floor(startedAtMs) },
  };
  if (largeImageKey === undefined || largeImageKey === "") return activity;
  return {
    ...activity,
    assets: { large_image: largeImageKey, large_text: DISCORD_APP_NAME },
  };
};

/** Idle presence is cleared, so only a live activity justifies a socket. */
export const shouldOpenDiscordConnection = (clientId: string, activity: unknown | null): boolean =>
  clientId !== "" && activity !== null;

class DiscordIpc {
  #socket: NodeNet.Socket | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #ready = false;
  #clientId = "";
  #rejectedClientId: string | undefined;
  #desiredActivity: DiscordActivity | null = null;
  #lastActivity: string | undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #nonce = 0;
  #pathIndex = 0;
  #attemptsRemaining = 0;

  readonly #candidates: ReadonlyArray<string>;

  constructor(candidates: ReadonlyArray<string>) {
    this.#candidates = candidates;
  }

  update(clientId: string, activity: DiscordActivity | null) {
    if (clientId !== this.#clientId) {
      this.#clientId = clientId;
      this.#rejectedClientId = undefined;
      this.#attemptsRemaining = 0;
      this.#destroySocket();
    }
    this.#desiredActivity = activity;
    if (!shouldOpenDiscordConnection(clientId, activity)) {
      if (this.#socket !== undefined && this.#ready) this.#sendDesiredActivity();
      return;
    }
    if (clientId === this.#rejectedClientId) return;
    if (this.#socket !== undefined) {
      if (this.#ready) this.#sendDesiredActivity();
      return;
    }
    this.#startConnectRound();
  }

  close() {
    this.#attemptsRemaining = 0;
    this.#destroySocket();
    this.#desiredActivity = null;
    this.#clientId = "";
  }

  #startConnectRound() {
    if (this.#candidates.length === 0) return;
    this.#attemptsRemaining = this.#candidates.length;
    this.#pathIndex = 0;
    this.#connectNext();
  }

  #connectNext() {
    if (!shouldOpenDiscordConnection(this.#clientId, this.#desiredActivity)) return;
    while (this.#socket === undefined && this.#attemptsRemaining > 0) {
      this.#attemptsRemaining -= 1;
      const index = this.#pathIndex;
      this.#pathIndex = (this.#pathIndex + 1) % this.#candidates.length;
      try {
        this.#openSocket(this.#candidates[index]!);
        return;
      } catch {
        // Missing pipe: fall through to the next candidate.
      }
    }
  }

  #openSocket(path: string) {
    const socket = NodeNet.createConnection(path);
    this.#socket = socket;
    this.#ready = false;
    this.#buffer = Buffer.alloc(0);
    const timer = setTimeout(() => this.#failSocket(socket), HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    this.#handshakeTimer = timer;
    socket.on("connect", () => {
      if (this.#socket !== socket) return;
      this.#writeFrame(OP_HANDSHAKE, { v: 1, client_id: this.#clientId });
    });
    socket.on("data", (chunk) => {
      if (this.#socket !== socket) return;
      this.#receive(chunk);
    });
    // Discord being closed is normal, so the next sweep simply tries again.
    socket.on("error", () => this.#failSocket(socket));
    socket.on("close", () => this.#failSocket(socket));
  }

  #receive(chunk: Buffer) {
    const combined = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const { frames, rest } = decodeDiscordFrames(combined);
    this.#buffer = rest;
    for (const frame of frames) {
      this.#handleFrame(frame);
      if (this.#socket === undefined) break;
    }
  }

  #handleFrame(frame: DiscordFrame) {
    if (frame.op === OP_PING) {
      this.#writeFrame(OP_PONG, parseJson(frame.data) ?? {});
      return;
    }
    if (frame.op === OP_CLOSE) {
      this.#failSocket(this.#socket);
      return;
    }
    if (frame.op !== OP_FRAME) return;
    const payload = parseJson(frame.data);
    if (!isRecord(payload)) return;
    if (payload["evt"] === "READY") {
      this.#ready = true;
      this.#attemptsRemaining = 0;
      this.#clearHandshakeTimer();
      this.#sendDesiredActivity();
      return;
    }
    // A handshake ERROR means the application ID is wrong; do not hammer it until it changes.
    if (payload["evt"] === "ERROR" && !this.#ready) {
      this.#rejectedClientId = this.#clientId;
      this.#attemptsRemaining = 0;
      this.#destroySocket();
    }
  }

  #sendDesiredActivity() {
    if (!this.#ready || this.#clientId === "") return;
    const serialized = JSON.stringify(this.#desiredActivity);
    if (serialized === this.#lastActivity) return;
    this.#lastActivity = serialized;
    this.#writeFrame(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: this.#desiredActivity },
      nonce: String(++this.#nonce),
    });
  }

  #writeFrame(op: number, payload: unknown) {
    const socket = this.#socket;
    if (socket === undefined) return;
    try {
      socket.write(encodeDiscordFrame(op, payload));
    } catch {
      this.#failSocket(socket);
    }
  }

  #failSocket(socket: NodeNet.Socket | undefined) {
    if (socket === undefined || this.#socket !== socket) return;
    this.#destroySocket();
    if (this.#attemptsRemaining > 0) this.#connectNext();
  }

  #destroySocket() {
    this.#clearHandshakeTimer();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#ready = false;
    this.#buffer = Buffer.alloc(0);
    this.#lastActivity = undefined;
    socket?.destroy();
  }

  #clearHandshakeTimer() {
    if (this.#handshakeTimer === undefined) return;
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }
}

const makeSweep = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ipc = new DiscordIpc(
    discordIpcPathCandidates(yield* HostProcess.Platform, yield* HostProcess.Environment),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => ipc.close()));
  let lastCheckMs = 0;
  let lastClientId: string | undefined;
  let activityStartedAtMs: number | undefined;

  return Effect.fn("DiscordPresence.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const { discordClientId } = yield* settings.getSettings;
    const clientId = discordClientId.trim();
    // Settings changes apply on the next tick instead of after the presence interval.
    if (clientId === lastClientId && nowMs - lastCheckMs < CHECK_INTERVAL_MS) return;
    if (clientId !== lastClientId) activityStartedAtMs = undefined;
    lastClientId = clientId;
    lastCheckMs = nowMs;

    // shortcut: mayBeLive also counts threads only watching a PR, so the count can run high.
    const liveAgents =
      clientId === ""
        ? 0
        : (yield* projections.listActiveShellIndex()).filter((thread) => thread.mayBeLive).length;
    if (liveAgents === 0) {
      activityStartedAtMs = undefined;
      ipc.update(clientId, null);
      return;
    }
    activityStartedAtMs ??= nowMs;
    ipc.update(clientId, presenceActivity(liveAgents, activityStartedAtMs));
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const sweep = yield* makeSweep;
    yield* scheduler.register("discord-presence", sweep());
  }),
);
