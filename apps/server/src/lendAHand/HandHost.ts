// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off globalFetch:off -- a private loopback listener and the helper's commands, both owned by this service.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import {
  type ComputerActInput,
  decodeHandCode,
  decodeInviteCode,
  encodeHandCode,
  HandActInput,
  HandError,
  HandHelloRequest,
  type HandHostLogEntry,
  type HandHostState,
  HandRunInput,
  type HandRunResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { captureScreen, performAct } from "../computer/desktop.ts";
import * as ServerConfig from "../config.ts";
import { ensureCloudflared, openTunnel, type Tunnel } from "./cloudflared.ts";

const CODE_TTL_MS = 15 * 60_000;
const SESSION_MAX_MS = 2 * 60 * 60_000;
const MAX_LOG = 200;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STREAM_CHARS = 100_000;
const DEFAULT_RUN_SECONDS = 60;
// Under Cloudflare's 100 s limit on a tunneled request, so a long command returns, not a 524.
const MAX_RUN_SECONDS = 90;
/** The helper's Mem says hello back before answering, and a fresh tunnel can take a while. */
const INVITE_POST_TIMEOUT_MS = 90_000;
const INVITE_RETRIES = 7;
const INVITE_RETRY_MS = 3_000;

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
    /** Starts sharing and hands the new code to the helper chat waiting behind an invite code. */
    readonly accept: (inviteCode: string) => Effect.Effect<HandHostState, HandError>;
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
            // Without this, progress records come back as CLIXML noise in stderr.
            Buffer.from(
              `$ProgressPreference = "SilentlyContinue"; ${input.command}`,
              "utf16le",
            ).toString("base64"),
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

export const readBody = (request: NodeHttp.IncomingMessage) =>
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
    teardown();
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
      // Lets the helper tell a lost request from an ended session.
      case "/hand/ping":
        return reply(200, {});
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
        const command = runCommand(platform, input);
        current.running.add(command.kill);
        const result = await command.done.finally(() => current.running.delete(command.kill));
        return reply(200, result);
      }
      case "/hand/screenshot": {
        await log("screenshot", "Took a screenshot");
        const shot = await runPromise(captureScreen);
        return reply(200, shot);
      }
      case "/hand/act": {
        const input = decodeAct(body);
        await log("act", describeAct(input));
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

  /** POSTs the hand code to the helper's invite listener, waiting out a tunnel still registering. */
  const deliver = async (url: string, secret: string, code: string) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${url}/hand/invite`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(INVITE_POST_TIMEOUT_MS),
      }).catch(() => undefined);
      const status = response?.status;
      if ((status === undefined || status === 502 || status === 530) && attempt < INVITE_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, INVITE_RETRY_MS));
        continue;
      }
      if (response === undefined || status === 502 || status === 530) {
        throw new Error("Couldn't reach the helper's Mem. Ask them for a new invite.");
      }
      if (status === 404 || status === 410) {
        throw new Error("That invite has ended or expired. Ask for a new one.");
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof body.error === "string" ? body.error : `The helper's Mem answered ${status}.`,
        );
      }
      return;
    }
  };

  const accept = Effect.fn("HandHost.accept")(function* (inviteCode: string) {
    const invite = decodeInviteCode(inviteCode);
    if (invite === null) {
      // The two boxes sit on opposite sides; a hand code here is the commonest mix-up.
      return yield* new HandError({
        message:
          decodeHandCode(inviteCode) !== null
            ? "That's a hand code, which lets your chat help their PC. Paste it in the chat you'll help from: the hand icon in the chat's header."
            : "That isn't an invite code. It starts with mem-invite-.",
      });
    }
    const started = yield* start();
    if (started.status !== "waiting" || started.code === null) {
      return yield* new HandError({
        message: "This PC is already being helped. End that session first.",
      });
    }
    const code = started.code;
    const delivered = yield* Effect.tryPromise({
      try: () => deliver(invite.url, invite.secret, code),
      catch: (cause) =>
        new HandError({
          message: cause instanceof Error ? cause.message : "Couldn't reach the helper's Mem.",
        }),
    }).pipe(Effect.result);
    const after = yield* SubscriptionRef.get(state);
    // The helper said hello, so the code arrived even if its reply got lost on the way back.
    if (delivered._tag === "Success" || after.status === "connected") return after;
    yield* end(delivered.failure.message);
    return yield* delivered.failure;
  });

  yield* Effect.addFinalizer(() => Effect.sync(teardown));

  return HandHost.of({ start, end, accept, changes: SubscriptionRef.changes(state) });
});

export const layer = Layer.effect(HandHost, make);
