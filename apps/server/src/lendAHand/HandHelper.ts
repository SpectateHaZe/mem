// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalTimersInEffect:off -- HTTP to the host's tunnel, and the invite listener the host's Mem posts its code to.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import {
  decodeHandCode,
  encodeInviteCode,
  type HandEndpoint,
  HandError,
  type HandHelloResponse,
  HandHelloResponse as HandHelloResponseSchema,
  type HandHelperState,
  HandInviteRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { ensureCloudflared, openTunnel } from "./cloudflared.ts";
import { bearerMatches, readBody } from "./HandHost.ts";

/** A fresh quick tunnel can take a few seconds to resolve; retry the first hello that long. */
const HELLO_RETRIES = 7;
const HELLO_RETRY = Duration.seconds(3);
const CALL_TIMEOUT_MS = 150_000;
const INVITE_TTL_MS = 15 * 60_000;
const PING_RETRIES = 4;
const PING_RETRY_MS = 2_000;
const decodeHelloResponse = Schema.decodeUnknownEffect(HandHelloResponseSchema);
const decodeInviteRequest = Schema.decodeUnknownSync(HandInviteRequest);

export class HandHelper extends Context.Service<
  HandHelper,
  {
    readonly connect: (
      threadId: ThreadId,
      code: string,
    ) => Effect.Effect<HandHelloResponse, HandError>;
    /** Disconnects this chat, or withdraws its invite. */
    readonly disconnect: (threadId: ThreadId) => Effect.Effect<HandHelperState>;
    /** Opens an invite for this chat: the host pastes its code, and their Mem connects back. */
    readonly invite: (threadId: ThreadId) => Effect.Effect<HandHelperState, HandError>;
    /** POSTs to the host this thread is connected to; the caller decodes the JSON reply. */
    readonly call: (
      threadId: ThreadId,
      route: "run" | "screenshot" | "act",
      body: unknown,
    ) => Effect.Effect<unknown, HandError>;
    readonly changes: Stream.Stream<HandHelperState>;
  }
>()("t3/lendAHand/HandHelper") {}

const post = (endpoint: HandEndpoint, route: string, body: unknown) =>
  // @effect-diagnostics-next-line globalFetch:off
  fetch(`${endpoint.url}/hand/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const state = yield* SubscriptionRef.make<HandHelperState>({ sessions: [], invites: [] });
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  // Secrets stay here, never in the state clients read.
  const endpoints = new Map<ThreadId, HandEndpoint>();
  // Each open invite's listener and tunnel, closed once used, withdrawn or expired.
  const inviteClosers = new Map<ThreadId, () => void>();

  const closeInvite = (threadId: ThreadId) => {
    inviteClosers.get(threadId)?.();
    inviteClosers.delete(threadId);
    return SubscriptionRef.updateAndGet(state, (current) => ({
      ...current,
      invites: current.invites.filter((invite) => invite.threadId !== threadId),
    }));
  };

  const forget = (threadId: ThreadId) => {
    endpoints.delete(threadId);
    return SubscriptionRef.updateAndGet(state, (current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.threadId !== threadId),
    }));
  };

  const hello = (endpoint: HandEndpoint) =>
    Effect.tryPromise({
      try: () => post(endpoint, "hello", { helperName: NodeOS.userInfo().username }),
      catch: () => "unreachable" as const,
    }).pipe(
      Effect.flatMap((response): Effect.Effect<unknown, HandError | "unreachable"> =>
        // A tunnel Cloudflare has not finished registering answers 502 or 530 for a moment.
        response.status === 502 || response.status === 530
          ? Effect.fail("unreachable" as const)
          : response.status === 404 || response.status === 410
            ? Effect.fail(
                new HandError({
                  message: "That hand code has ended or expired. Ask for a new one.",
                }),
              )
            : response.ok
              ? Effect.tryPromise({
                  try: () => response.json() as Promise<unknown>,
                  catch: () => new HandError({ message: "The other PC sent an unexpected reply." }),
                })
              : Effect.fail(
                  new HandError({ message: `The other PC answered ${response.status}.` }),
                ),
      ),
      Effect.flatMap((json) =>
        decodeHelloResponse(json).pipe(
          Effect.mapError(
            () => new HandError({ message: "The other PC sent an unexpected reply." }),
          ),
        ),
      ),
      Effect.retry({
        while: (error) => error === "unreachable",
        schedule: Schedule.spaced(HELLO_RETRY),
        times: HELLO_RETRIES,
      }),
      Effect.mapError((error) =>
        error === "unreachable"
          ? new HandError({
              message:
                "Couldn't reach the other PC. Check that their Mem is still sharing, then try again.",
            })
          : error,
      ),
    );

  const connect = Effect.fn("HandHelper.connect")(function* (threadId: ThreadId, code: string) {
    const endpoint = decodeHandCode(code);
    if (endpoint === null) {
      return yield* new HandError({
        message: "That isn't a hand code. Ask for a new one: it starts with mem-hand-.",
      });
    }
    const answer = yield* hello(endpoint);
    const connectedAtMs = yield* Clock.currentTimeMillis;
    endpoints.set(threadId, endpoint);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      sessions: [
        ...current.sessions.filter((session) => session.threadId !== threadId),
        { threadId, hostName: answer.hostName, platform: answer.platform, connectedAtMs },
      ],
    }));
    return answer;
  });

  const stillConnected = (endpoint: HandEndpoint) =>
    Effect.promise(async () => {
      for (let attempt = 0; attempt < PING_RETRIES; attempt++) {
        const status = await post(endpoint, "ping", {}).then(
          (response) => response.status,
          () => undefined,
        );
        if (status === 200) return true;
        if (status === 404 || status === 410) return false;
        await new Promise((resolve) => setTimeout(resolve, PING_RETRY_MS));
      }
      return false;
    });

  const call = Effect.fn("HandHelper.call")(function* (
    threadId: ThreadId,
    route: "run" | "screenshot" | "act",
    body: unknown,
  ) {
    const endpoint = endpoints.get(threadId);
    if (endpoint === undefined) {
      return yield* new HandError({
        message:
          "This chat isn't connected to anyone's PC. The user connects it with Lend a hand in the chat header.",
      });
    }
    const outcome = yield* Effect.tryPromise({
      try: async () => {
        const response = await post(endpoint, route, body);
        const json: unknown = await response.json().catch(() => ({}));
        return { status: response.status, json };
      },
      catch: () =>
        new HandError({ message: "Couldn't reach the other PC. Their Mem may have closed." }),
    });
    // 502 and 530 mean Cloudflare couldn't reach their Mem: often a moment's hiccup, so ask
    // whether the session is still there before dropping it.
    if (outcome.status === 502 || outcome.status === 530) {
      if (yield* stillConnected(endpoint)) {
        return yield* new HandError({
          message: `The request was lost on the way (Cloudflare ${outcome.status}) but the session is still connected. Try again; a command may or may not have run.`,
        });
      }
    }
    if ([404, 410, 502, 530].includes(outcome.status)) {
      yield* forget(threadId);
      return yield* new HandError({
        message: `The session ended (${outcome.status}): the other person pressed End or Esc, or closed Mem. Their Lend a hand screen says why.`,
      });
    }
    if (outcome.status !== 200) {
      const error = (outcome.json as { error?: unknown }).error;
      return yield* new HandError({
        message: typeof error === "string" ? error : `The other PC answered ${outcome.status}.`,
      });
    }
    return outcome.json;
  });

  /** Serves POST /hand/invite: the host's Mem sends its hand code, and this chat connects with it. */
  const serveInvite =
    (threadId: ThreadId, secret: string) =>
    (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (
        request.method !== "POST" ||
        request.url !== "/hand/invite" ||
        !bearerMatches(request.headers.authorization, secret)
      ) {
        return reply(404, { error: "Not found." });
      }
      readBody(request)
        .then((body) => runPromise(connect(threadId, decodeInviteRequest(body).code)))
        .then(
          (answer) => {
            reply(200, { hostName: answer.hostName });
            void runPromise(closeInvite(threadId));
          },
          // A failed connect leaves the invite open, so the host can try again.
          (error: unknown) =>
            reply(400, {
              error:
                error instanceof Error && error.message !== ""
                  ? error.message
                  : "The helper's Mem could not connect.",
            }),
        );
    };

  const invite = Effect.fn("HandHelper.invite")(function* (threadId: ThreadId) {
    yield* closeInvite(threadId);
    const secret = NodeCrypto.randomBytes(32).toString("base64url");
    const server = NodeHttp.createServer(serveInvite(threadId, secret));
    const tunnel = yield* Effect.tryPromise({
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
      catch: (cause) => {
        server.close();
        return new HandError({
          message: cause instanceof Error ? cause.message : "The invite could not be opened.",
        });
      },
    });
    const timer = setTimeout(() => void runPromise(closeInvite(threadId)), INVITE_TTL_MS);
    inviteClosers.set(threadId, () => {
      clearTimeout(timer);
      tunnel.close();
      server.close();
      server.closeAllConnections();
    });
    tunnel.onExit(() => void runPromise(closeInvite(threadId)));
    const now = yield* Clock.currentTimeMillis;
    return yield* SubscriptionRef.updateAndGet(state, (current) => ({
      ...current,
      invites: [
        ...current.invites.filter((entry) => entry.threadId !== threadId),
        {
          threadId,
          code: encodeInviteCode({ url: tunnel.url, secret }),
          expiresAtMs: now + INVITE_TTL_MS,
        },
      ],
    }));
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const close of inviteClosers.values()) close();
      inviteClosers.clear();
    }),
  );

  return HandHelper.of({
    connect,
    disconnect: Effect.fn("HandHelper.disconnect")(function* (threadId: ThreadId) {
      yield* closeInvite(threadId);
      return yield* forget(threadId);
    }),
    invite,
    call,
    changes: SubscriptionRef.changes(state),
  });
});

export const layer = Layer.effect(HandHelper, make);
