// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off -- a private loopback listener and the helper's commands, both owned by this service.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import {
  type ComputerActInput,
  encodeHandCode,
  HandActInput,
  HandError,
  HandHelloRequest,
  type HandHostLogEntry,
  type HandHostState,
  HandRunInput,
  type HandRunResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ComputerUseActivity from "../computer/ComputerUseActivity.ts";
import { captureScreen, performAct } from "../computer/desktop.ts";
import * as ServerConfig from "../config.ts";
import { ensureCloudflared, openTunnel, type Tunnel } from "./cloudflared.ts";

/** The glow's owner while a helper drives: Esc on this id ends the session instead of a thread. */
export const HAND_CALLER = {
  threadId: ThreadId.make("lend-a-hand"),
  projectId: ProjectId.make("lend-a-hand"),
};

const CODE_TTL_MS = 15 * 60_000;
const SESSION_MAX_MS = 2 * 60 * 60_000;
const MAX_LOG = 200;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STREAM_CHARS = 100_000;
const DEFAULT_RUN_SECONDS = 60;
const MAX_RUN_SECONDS = 120;

const decodeHello = Schema.decodeUnknownSync(HandHelloRequest);
const decodeRun = Schema.decodeUnknownSync(HandRunInput);
const decodeAct = Schema.decodeUnknownSync(HandActInput);

const OFF: HandHostState = {
  status: "off",
  code: null,
  helperName: null,
  expiresAtMs: null,
  error: null,
  log: [],
};

export class HandHost extends Context.Service<
  HandHost,
  {
    readonly start: () => Effect.Effect<HandHostState, HandError>;
    readonly end: (reason?: string) => Effect.Effect<HandHostState>;
    readonly changes: Stream.Stream<HandHostState>;
  }
>()("t3/lendAHand/HandHost") {}

/** Constant-time bearer check; a wrong length is a mismatch, never an early exit on content. */
export const bearerMatches = (header: string | undefined, secret: string) => {
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected);
};

const capped = (text: string) =>
  text.length > MAX_STREAM_CHARS
    ? { text: text.slice(0, MAX_STREAM_CHARS), truncated: true }
    : { text, truncated: false };

/** Runs one helper command as this user; the returned kill ends it early. */
const runCommand = (platform: NodeJS.Platform, input: HandRunInput) => {
  const seconds = Math.min(
    Math.max(input.timeoutSeconds ?? DEFAULT_RUN_SECONDS, 1),
    MAX_RUN_SECONDS,
  );
  const [file, args] =
    platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(input.command, "utf16le").toString("base64"),
          ],
        ]
      : ["/bin/sh", ["-c", input.command]];
  let child: NodeChildProcess.ChildProcess | undefined;
  const done = new Promise<HandRunResult>((resolve) => {
    child = NodeChildProcess.execFile(
      file,
      args,
      { timeout: seconds * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const out = capped(String(stdout));
        const err = capped(String(stderr));
        const timedOut = error !== null && error.killed === true;
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({
          exitCode: timedOut ? null : code,
          stdout: out.text,
          stderr: err.text,
          timedOut,
          truncated: out.truncated || err.truncated,
        });
      },
    );
  });
  return { done, kill: () => child?.kill() };
};

const readBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });

const describeAct = (input: ComputerActInput) =>
  input.action === "type"
    ? `Typed ${input.text?.length ?? 0} characters`
    : input.action === "key"
      ? `Pressed ${input.text ?? "a key"}`
      : input.x !== undefined && input.y !== undefined
        ? `${input.action.replace("_", " ")} at ${input.x}, ${input.y}`
        : input.action.replace("_", " ");

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const activity = yield* ComputerUseActivity.ComputerUseActivity;
  const state = yield* SubscriptionRef.make<HandHostState>(OFF);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  // One session at a time, held outside Effect because the Node listener drives it.
  let session:
    | {
        readonly server: NodeHttp.Server;
        tunnel: Tunnel | undefined;
        timer: ReturnType<typeof setTimeout> | undefined;
        readonly running: Set<() => void>;
      }
    | undefined;

  const update = (next: (current: HandHostState) => HandHostState) =>
    runPromise(SubscriptionRef.update(state, next));
  const log = (kind: HandHostLogEntry["kind"], summary: string) =>
    update((current) => ({
      ...current,
      log: [...current.log, { atMs: Date.now(), kind, summary }].slice(-MAX_LOG),
    }));

  const teardown = () => {
    const current = session;
    session = undefined;
    if (current === undefined) return;
    if (current.timer !== undefined) clearTimeout(current.timer);
    for (const kill of current.running) kill();
    current.tunnel?.close();
    current.server.close();
    current.server.closeAllConnections();
  };

  const end = Effect.fn("HandHost.end")(function* (reason?: string) {
    const wasOn = session !== undefined;
    teardown();
    if (wasOn) yield* activity.stop();
    return yield* SubscriptionRef.updateAndGet(state, (current): HandHostState => ({
      ...OFF,
      error: reason ?? null,
      log: current.log,
    }));
  });
  const endLater = (reason: string) => void runPromise(end(reason));

  const handle = async (
    secret: string,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || !bearerMatches(request.headers.authorization, secret)) {
      return reply(404, { error: "Not found." });
    }
    const current = session;
    if (current === undefined) return reply(410, { error: "The host ended the session." });
    const body = await readBody(request);
    switch (request.url) {
      case "/hand/hello": {
        const { helperName } = decodeHello(body);
        const name = helperName.trim().slice(0, 60) || "Someone";
        if (current.timer !== undefined) clearTimeout(current.timer);
        current.timer = setTimeout(
          () => endLater("The session reached its 2 hour limit."),
          SESSION_MAX_MS,
        );
        await update((value): HandHostState => ({
          ...value,
          status: "connected",
          code: null,
          helperName: name,
          expiresAtMs: Date.now() + SESSION_MAX_MS,
        }));
        await log("connected", `${name} connected`);
        return reply(200, { hostName: NodeOS.userInfo().username, platform });
      }
      case "/hand/run": {
        const input = decodeRun(body);
        await log("run", input.command.slice(0, 300));
        await runPromise(activity.act(HAND_CALLER, { action: "move" }));
        const command = runCommand(platform, input);
        current.running.add(command.kill);
        const result = await command.done.finally(() => current.running.delete(command.kill));
        return reply(200, result);
      }
      case "/hand/screenshot": {
        await log("screenshot", "Took a screenshot");
        const shot = await runPromise(captureScreen);
        await runPromise(activity.screenshot(HAND_CALLER, shot));
        return reply(200, shot);
      }
      case "/hand/act": {
        const input = decodeAct(body);
        await log("act", describeAct(input));
        await runPromise(activity.act(HAND_CALLER, input));
        return reply(200, await runPromise(performAct(input)));
      }
      default:
        return reply(404, { error: "Not found." });
    }
  };

  const start = Effect.fn("HandHost.start")(function* () {
    if (session !== undefined) return yield* SubscriptionRef.get(state);
    yield* SubscriptionRef.set<HandHostState>(state, { ...OFF, status: "starting" });
    const secret = NodeCrypto.randomBytes(32).toString("base64url");
    const server = NodeHttp.createServer((request, response) => {
      handle(secret, request, response).catch((error: unknown) => {
        if (response.headersSent) return response.end();
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed." }));
      });
    });
    session = { server, tunnel: undefined, timer: undefined, running: new Set() };
    const opened = Effect.tryPromise({
      try: async () => {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No local port.");
        const executable = await ensureCloudflared(stateDir, platform);
        return await openTunnel(executable, `http://127.0.0.1:${address.port}`);
      },
      catch: (cause) =>
        new HandError({
          message: cause instanceof Error ? cause.message : "Lend a Hand could not start.",
        }),
    });
    const tunnel = yield* opened.pipe(Effect.tapError((error) => end(error.message)));
    const current = session;
    if (current === undefined) {
      // Ended while the tunnel was opening.
      tunnel.close();
      return yield* SubscriptionRef.get(state);
    }
    current.tunnel = tunnel;
    tunnel.onExit(() => endLater("The Cloudflare tunnel closed."));
    current.timer = setTimeout(() => {
      if (session === current) endLater("The hand code expired without anyone using it.");
    }, CODE_TTL_MS);
    return yield* SubscriptionRef.updateAndGet(state, (value): HandHostState => ({
      ...value,
      status: "waiting",
      code: encodeHandCode({ url: tunnel.url, secret }),
      expiresAtMs: Date.now() + CODE_TTL_MS,
    }));
  });

  yield* Effect.addFinalizer(() => Effect.sync(teardown));

  return HandHost.of({ start, end, changes: SubscriptionRef.changes(state) });
});

export const layer = Layer.effect(HandHost, make);
