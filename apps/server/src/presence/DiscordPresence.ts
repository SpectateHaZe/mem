import * as NodeNet from "node:net";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";

const CHECK_INTERVAL_MS = 15_000;
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;

export const encodeDiscordFrame = (op: number, payload: unknown) => {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

// Never names a project or thread: Discord shows this to the user's friends.
export const presenceActivity = (liveAgents: number) =>
  liveAgents === 0
    ? null
    : { details: liveAgents === 1 ? "1 agent working" : `${liveAgents} agents working` };

const discordIpcPath = (platform: string, env: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? "\\\\?\\pipe\\discord-ipc-0"
    : `${env["XDG_RUNTIME_DIR"] ?? env["TMPDIR"] ?? "/tmp"}/discord-ipc-0`;

class DiscordIpc {
  #socket: NodeNet.Socket | undefined;
  #ready = false;
  #clientId = "";
  #lastActivity: string | undefined;
  #nonce = 0;

  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  update(clientId: string, activity: ReturnType<typeof presenceActivity>) {
    if (clientId !== this.#clientId) this.close();
    this.#clientId = clientId;
    if (clientId === "") return;
    if (this.#socket === undefined) {
      this.#connect(clientId);
      return;
    }
    if (!this.#ready) return;
    const serialized = JSON.stringify(activity);
    if (serialized === this.#lastActivity) return;
    this.#lastActivity = serialized;
    this.#socket.write(
      encodeDiscordFrame(OP_FRAME, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity },
        nonce: String(++this.#nonce),
      }),
    );
  }

  #connect(clientId: string) {
    const socket = NodeNet.createConnection(this.#path);
    this.#socket = socket;
    socket.on("connect", () => {
      socket.write(encodeDiscordFrame(OP_HANDSHAKE, { v: 1, client_id: clientId }));
    });
    socket.once("data", () => {
      this.#ready = true;
    });
    // Discord being closed is normal, so the next check simply tries again.
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }

  close() {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#ready = false;
    this.#lastActivity = undefined;
    socket?.destroy();
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const scheduler = yield* Scheduler.Scheduler;
    const ipc = new DiscordIpc(
      discordIpcPath(yield* HostProcess.Platform, yield* HostProcess.Environment),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => ipc.close()));
    let lastCheckMs = 0;

    yield* scheduler.register(
      "discord-presence",
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (nowMs - lastCheckMs < CHECK_INTERVAL_MS) return;
        lastCheckMs = nowMs;
        const { discordClientId } = yield* settings.getSettings;
        // shortcut: mayBeLive also counts threads only watching a PR, so the count can run high.
        const liveAgents =
          discordClientId === ""
            ? 0
            : (yield* projections.listActiveShellIndex()).filter((thread) => thread.mayBeLive)
                .length;
        ipc.update(discordClientId, presenceActivity(liveAgents));
      }),
    );
  }),
);
