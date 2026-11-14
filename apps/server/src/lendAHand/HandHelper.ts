// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- HTTP to the host's tunnel, one request per tool call.
import * as NodeOS from "node:os";

import {
  decodeHandCode,
  type HandEndpoint,
  HandError,
  type HandHelloResponse,
  HandHelloResponse as HandHelloResponseSchema,
  type HandHelperState,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** A fresh quick tunnel can take a few seconds to resolve; retry the first hello that long. */
const HELLO_RETRIES = 7;
const HELLO_RETRY = Duration.seconds(3);
const CALL_TIMEOUT_MS = 150_000;
const decodeHelloResponse = Schema.decodeUnknownEffect(HandHelloResponseSchema);

export class HandHelper extends Context.Service<
  HandHelper,
  {
    readonly connect: (
      threadId: ThreadId,
      code: string,
    ) => Effect.Effect<HandHelloResponse, HandError>;
    readonly disconnect: (threadId: ThreadId) => Effect.Effect<HandHelperState>;
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
  const state = yield* SubscriptionRef.make<HandHelperState>({ sessions: [] });
  // Secrets stay here, never in the state clients read.
  const endpoints = new Map<ThreadId, HandEndpoint>();

  const forget = (threadId: ThreadId) => {
    endpoints.delete(threadId);
    return SubscriptionRef.updateAndGet(state, (current) => ({
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
      sessions: [
        ...current.sessions.filter((session) => session.threadId !== threadId),
        { threadId, hostName: answer.hostName, platform: answer.platform, connectedAtMs },
      ],
    }));
    return answer;
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
    // 502 and 530 are Cloudflare saying the tunnel behind the code is gone.
    if ([404, 410, 502, 530].includes(outcome.status)) {
      yield* forget(threadId);
      return yield* new HandError({
        message: "The session ended: the other person ended it or closed Mem.",
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

  return HandHelper.of({
    connect,
    disconnect: Effect.fn("HandHelper.disconnect")(function* (threadId: ThreadId) {
      return yield* forget(threadId);
    }),
    call,
    changes: SubscriptionRef.changes(state),
  });
});

export const layer = Layer.effect(HandHelper, make);
