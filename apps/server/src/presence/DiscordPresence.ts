// @effect-diagnostics globalTimers:off - The Discord socket owns its handshake deadline outside the Effect runtime.
import * as NodeNet from "node:net";

import {
  DEFAULT_DISCORD_PRESENCE_SETTINGS,
  resolveDiscordActivityButtons,
  resolveDiscordPresenceShowProjectName,
  type DiscordActivityButton,
  type DiscordPresenceSettings,
} from "@t3tools/contracts/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as MemIdleTracker from "../overseer/MemIdleTracker.ts";
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

const runtimeDirectory = (platform: NodeJS.Platform | string, env: NodeJS.ProcessEnv) =>
  (platform === "darwin"
    ? (env["TMPDIR"] ?? "/tmp")
    : (env["XDG_RUNTIME_DIR"] ?? env["TMPDIR"] ?? env["TMP"] ?? env["TEMP"] ?? "/tmp")
  ).replace(/[\\/]+$/, "") || "/";

export const discordIpcPathCandidates = (
  platform: NodeJS.Platform | string,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> =>
  platform === "win32"
    ? Array.from({ length: IPC_SOCKET_COUNT }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`)
    : (() => {
        const directory = runtimeDirectory(platform, env);
        return Array.from(
          { length: IPC_SOCKET_COUNT },
          (_, index) => `${directory}/discord-ipc-${index}`,
        );
      })();

export interface DiscordActivity {
  readonly details?: string;
  readonly state?: string;
  readonly timestamps?: { readonly start: number };
  readonly assets?: {
    readonly large_image?: string;
    readonly large_text?: string;
    readonly small_image?: string;
    readonly small_text?: string;
  };
  readonly buttons?: ReadonlyArray<DiscordActivityButton>;
}

// Discord rejects presence fields shorter than 2 or longer than 128 characters.
const DISCORD_FIELD_MAX_LENGTH = 128;
const DISCORD_FIELD_MIN_LENGTH = 2;
// Two parts and their separator must fit the field, so each part stays well under the maximum.
const STATE_PART_MAX_LENGTH = Math.floor((DISCORD_FIELD_MAX_LENGTH - 8) / 2);

/** Keeps a field within Discord's limits; an ellipsis takes the room of one character. */
const truncateDiscordText = (value: string): string =>
  value.length > DISCORD_FIELD_MAX_LENGTH
    ? cutBeforeEllipsis(value, DISCORD_FIELD_MAX_LENGTH)
    : value;

const truncateStatePart = (value: string): string =>
  value.length > STATE_PART_MAX_LENGTH ? cutBeforeEllipsis(value, STATE_PART_MAX_LENGTH) : value;

// Surrogates are counted as two characters here but one character on Discord, and a
// cut between a pair's halves would send Discord an invalid lone surrogate.
const cutsSurrogatePair = (value: string, end: number): boolean => {
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
};

const cutBeforeEllipsis = (value: string, maxLength: number): string => {
  const end = maxLength - 1;
  return `${value.slice(0, cutsSurrogatePair(value, end) ? end - 1 : end)}…`;
};

/**
 * One distinct value, or the first with a "+n more", so a field never becomes
 * an unreadable list. Blank values drop before counting.
 */
const distinctStateParts = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
};

const summarizeStatePart = (values: ReadonlyArray<string>): string | undefined => {
  const distinct = distinctStateParts(values);
  if (distinct.length === 0) return undefined;
  if (distinct.length === 1) return truncateStatePart(distinct[0]!);
  return `${truncateStatePart(distinct[0]!)} +${distinct.length - 1} more`;
};

/**
 * Never names a thread: Discord shows this to the user's friends, so project
 * names only appear when the user turns them on.
 * Zero live agents clears the presence instead of leaving a stale count.
 * A large image key must already be registered on the Discord application.
 */
export const presenceActivity = (
  liveAgents: number,
  startedAtMs: number,
  options: {
    readonly modelNames?: ReadonlyArray<string>;
    readonly projectNames?: ReadonlyArray<string>;
    /** The user's Rich Presence text and images; the defaults keep Discord's original card. */
    readonly presence?: DiscordPresenceSettings;
    /** The overseer is driving the sessions, so presence survives with no thread running. */
    readonly overseerInControl?: boolean;
    /** Only claim the owner is away when idle detection actually said so. */
    readonly ownerAfk?: boolean;
  } = {},
): DiscordActivity | null => {
  const agents = Number.isFinite(liveAgents) ? Math.max(0, Math.floor(liveAgents)) : 0;
  const overseer = options.overseerInControl === true;
  if (agents === 0 && !overseer) return null;
  const presence = options.presence ?? DEFAULT_DISCORD_PRESENCE_SETTINGS;
  if (!presence.enabled) return null;
  const values: DiscordTemplateValues = {
    agents,
    project: summarizeStatePart(options.projectNames ?? []) ?? "",
    model: summarizeStatePart(options.modelNames ?? []) ?? "",
    mode: summarizeMode({ overseer, ownerAfk: options.ownerAfk === true }),
  };
  // Mem driving with nothing running is a state, not a count, so the idle text replaces the template.
  const details = discordField(
    overseer && agents === 0
      ? presence.idleText
      : renderDiscordTemplate(presence.detailsTemplate, values),
  );
  const state = discordField(renderDiscordTemplate(presence.stateTemplate, values));
  const assets = presenceAssets(presence);
  const activity: DiscordActivity = {
    ...(details === undefined ? {} : { details }),
    ...(state === undefined ? {} : { state }),
    ...(presence.showElapsedTimer ? { timestamps: { start: Math.floor(startedAtMs) } } : {}),
    ...(Object.keys(assets).length === 0 ? {} : { assets }),
  };
  // Discord's SET_ACTIVITY with an empty object clears the card anyway, so report it as no presence.
  if (Object.keys(activity).length === 0) return null;
  // Buttons hang off a card, so they never keep an otherwise empty one alive.
  const buttons = resolveDiscordActivityButtons(presence);
  return buttons.length === 0 ? activity : { ...activity, buttons };
};

export interface DiscordTemplateValues {
  readonly agents: number;
  /** The summarized project names, or empty when the owner keeps them private. */
  readonly project: string;
  /** The summarized model names. */
  readonly model: string;
  /** Who is driving, such as "mem in control". */
  readonly mode: string;
}

const PLACEHOLDER = /\{(agents|project|model|mode)\}/g;

/**
 * Fills a presence template and keeps it Discord-legal: empty placeholders never leave a
 * dangling " · " separator, and the result stays within the field's character limit.
 */
export const renderDiscordTemplate = (template: string, values: DiscordTemplateValues): string => {
  const agents = Number.isFinite(values.agents) ? Math.max(0, Math.floor(values.agents)) : 0;
  const replacements: Readonly<Record<string, string>> = {
    agents: agents === 1 ? "1 agent" : `${agents} agents`,
    project: values.project,
    model: values.model,
    mode: values.mode,
  };
  const substituted = template.replace(
    PLACEHOLDER,
    (_match, placeholder: string) => replacements[placeholder] ?? "",
  );
  const joined = substituted
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" · ");
  return truncateDiscordText(joined.replace(/\s+/g, " "));
};

const summarizeMode = (input: { readonly overseer: boolean; readonly ownerAfk: boolean }): string =>
  [input.overseer && input.ownerAfk ? "user is afk" : "", input.overseer ? "mem in control" : ""]
    .filter((part) => part !== "")
    .join(" · ");

/** Discord rejects fields shorter than two characters, so a blank line drops instead. */
const discordField = (value: string): string | undefined => {
  const text = truncateDiscordText(value.trim());
  return text.length >= DISCORD_FIELD_MIN_LENGTH ? text : undefined;
};

const presenceAssets = (
  presence: DiscordPresenceSettings,
): NonNullable<DiscordActivity["assets"]> => {
  const largeImage = presence.largeImageKey.trim();
  const smallImage = presence.smallImageKey.trim();
  const largeText = discordField(presence.largeImageText);
  const smallText = discordField(presence.smallImageText);
  return {
    ...(largeImage === ""
      ? {}
      : { large_image: largeImage, ...(largeText === undefined ? {} : { large_text: largeText }) }),
    ...(smallImage === ""
      ? {}
      : { small_image: smallImage, ...(smallText === undefined ? {} : { small_text: smallText }) }),
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
  const projects = yield* ProjectStore.ProjectStoreV2;
  const idleTracker = yield* MemIdleTracker.MemIdleTracker;
  const ipc = new DiscordIpc(
    discordIpcPathCandidates(yield* HostProcess.Platform, yield* HostProcess.Environment),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => ipc.close()));
  let lastCheckMs = 0;
  let lastClientId: string | undefined;
  let lastEnabled: boolean | undefined;
  let activityStartedAtMs: number | undefined;

  return Effect.fn("DiscordPresence.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const settingsValue = yield* settings.getSettings;
    const { discordClientId, discordPresence, mem } = settingsValue;
    const clientId = discordClientId.trim();
    const enabled = discordPresence.enabled;
    // Settings changes apply on the next tick instead of after the presence interval.
    if (
      clientId === lastClientId &&
      enabled === lastEnabled &&
      nowMs - lastCheckMs < CHECK_INTERVAL_MS
    )
      return;
    if (clientId !== lastClientId || enabled !== lastEnabled) activityStartedAtMs = undefined;
    lastClientId = clientId;
    lastEnabled = enabled;
    lastCheckMs = nowMs;

    // A disabled presence clears the card, and leaving the socket up avoids a mid-handshake teardown.
    if (clientId === "" || !enabled) {
      activityStartedAtMs = undefined;
      ipc.update(clientId, null);
      return;
    }

    // shortcut: mayBeLive also counts threads only watching a PR, so the count can run high.
    const liveThreads = (yield* projections.listActiveShellIndex()).filter(
      (thread) => thread.mayBeLive,
    );
    if (liveThreads.length === 0 && !mem.enabled) {
      activityStartedAtMs = undefined;
      ipc.update(clientId, null);
      return;
    }
    activityStartedAtMs ??= nowMs;
    // Project names are opt-in: list them in thread order, so the first live thread's project leads.
    const projectIds = [...new Set(liveThreads.map((thread) => thread.projectId))];
    const showProjectName = resolveDiscordPresenceShowProjectName(settingsValue);
    const projectNames =
      showProjectName && projectIds.length > 0
        ? (yield* projects.list({ projectIds })).map((project) => project.title)
        : [];
    // The sweep already runs on its own interval, so the idle check rides along instead of a timer.
    const ownerAfk = mem.enabled ? yield* idleTracker.isOwnerAway(mem.idleThresholdMinutes) : false;
    ipc.update(
      clientId,
      presenceActivity(liveThreads.length, activityStartedAtMs, {
        modelNames: liveThreads
          .map((thread) => thread.modelName)
          .filter((name): name is string => name !== null),
        projectNames,
        presence: discordPresence,
        overseerInControl: mem.enabled,
        ownerAfk,
      }),
    );
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const sweep = yield* makeSweep;
    yield* scheduler.register("discord-presence", sweep());
  }),
);
