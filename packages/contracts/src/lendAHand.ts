import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ComputerActInput, ComputerActResult, ComputerScreenshotInput } from "./computer.ts";

/**
 * Lend a Hand: a host lets one chat in a helper's Mem work on the host's PC. The host's Mem serves
 * a private listener through a Cloudflare quick tunnel; the hand code carries its address and a
 * bearer secret. See docs/superpowers/specs/2026-11-14-lend-a-hand-design.md.
 */

const HAND_CODE_PREFIX = "mem-hand-";
/** Quick tunnels only: a pasted code must not point the helper's server at an arbitrary host. */
const TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

export interface HandEndpoint {
  readonly url: string;
  readonly secret: string;
}

const toBase64Url = (text: string) =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromBase64Url = (text: string) => atob(text.replaceAll("-", "+").replaceAll("_", "/"));

export const encodeHandCode = (endpoint: HandEndpoint): string =>
  HAND_CODE_PREFIX + toBase64Url(JSON.stringify({ u: endpoint.url, s: endpoint.secret }));

/** The endpoint a hand code names, or null for anything that is not a code from a quick tunnel. */
export const decodeHandCode = (code: string): HandEndpoint | null => {
  const trimmed = code.trim();
  if (!trimmed.startsWith(HAND_CODE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(trimmed.slice(HAND_CODE_PREFIX.length)));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { u, s } = parsed as { u?: unknown; s?: unknown };
    if (typeof u !== "string" || typeof s !== "string" || s.length < 32) return null;
    const url = new URL(u);
    if (url.protocol !== "https:" || !TUNNEL_HOST.test(url.hostname)) return null;
    return { url: url.origin, secret: s };
  } catch {
    return null;
  }
};

// The wire protocol between the helper's server and the host's listener.

export const HandHelloRequest = Schema.Struct({ helperName: Schema.String });
export const HandHelloResponse = Schema.Struct({
  hostName: Schema.String,
  platform: Schema.String,
});
export type HandHelloResponse = typeof HandHelloResponse.Type;

export const HandRunInput = Schema.Struct({
  command: Schema.String.annotate({
    description: "PowerShell on Windows hosts, /bin/sh on macOS. Runs as the host's user.",
  }),
  timeoutSeconds: Schema.optional(Schema.Int.annotate({ description: "Default 60, at most 120." })),
});
export type HandRunInput = typeof HandRunInput.Type;

export const HandRunResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type HandRunResult = typeof HandRunResult.Type;

export const HandScreenshotInput = ComputerScreenshotInput;

export const HandScreenshot = Schema.Struct({
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});
export type HandScreenshot = typeof HandScreenshot.Type;

export const HandScreenshotResult = Schema.Struct({
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});

export const HandActInput = ComputerActInput;
export const HandActResult = ComputerActResult;

// The host's side, as its own Mem shows it.

export const HandHostLogEntry = Schema.Struct({
  atMs: Schema.Number,
  kind: Schema.Literals(["connected", "run", "screenshot", "act"]),
  summary: Schema.String,
});
export type HandHostLogEntry = typeof HandHostLogEntry.Type;

export const HandHostState = Schema.Struct({
  status: Schema.Literals(["off", "starting", "waiting", "connected"]),
  code: Schema.NullOr(Schema.String),
  helperName: Schema.NullOr(Schema.String),
  /** When the unused code or the session runs out. */
  expiresAtMs: Schema.NullOr(Schema.Number),
  /** Why the last attempt or session ended early. */
  error: Schema.NullOr(Schema.String),
  log: Schema.Array(HandHostLogEntry),
});
export type HandHostState = typeof HandHostState.Type;

// The helper's side: which chats are connected to whose PC.

export const HandConnectInput = Schema.Struct({
  threadId: ThreadId,
  code: TrimmedNonEmptyString,
});

export const HandThreadInput = Schema.Struct({ threadId: ThreadId });

export const HandHelperSession = Schema.Struct({
  threadId: ThreadId,
  hostName: Schema.String,
  platform: Schema.String,
  connectedAtMs: Schema.Number,
});
export type HandHelperSession = typeof HandHelperSession.Type;

export const HandHelperState = Schema.Struct({ sessions: Schema.Array(HandHelperSession) });
export type HandHelperState = typeof HandHelperState.Type;

export const HandConnectResult = Schema.Struct({ hostName: Schema.String });

export class HandError extends Schema.TaggedError<HandError>()("HandError", {
  message: Schema.String,
}) {}
