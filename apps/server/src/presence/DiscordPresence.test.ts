import { assert, it } from "@effect/vitest";

import {
  decodeDiscordFrames,
  discordIpcPathCandidates,
  encodeDiscordFrame,
  presenceActivity,
  shouldOpenDiscordConnection,
} from "./DiscordPresence.ts";

it("frames messages with a little-endian opcode and length", () => {
  const frame = encodeDiscordFrame(1, { a: 1 });
  assert.equal(frame.readInt32LE(0), 1);
  assert.equal(frame.readInt32LE(4), 7);
  assert.equal(frame.subarray(8).toString(), '{"a":1}');
});

it("decodes several frames from one chunk", () => {
  const chunk = Buffer.concat([
    encodeDiscordFrame(1, { evt: "READY" }),
    encodeDiscordFrame(1, { cmd: "SET_ACTIVITY" }),
  ]);
  const { frames, rest } = decodeDiscordFrames(chunk);
  assert.lengthOf(frames, 2);
  assert.deepEqual(JSON.parse(frames[0]!.data), { evt: "READY" });
  assert.deepEqual(JSON.parse(frames[1]!.data), { cmd: "SET_ACTIVITY" });
  assert.equal(rest.length, 0);
});

it("keeps an unfinished frame until the rest arrives", () => {
  const frame = encodeDiscordFrame(1, { evt: "READY" });
  const firstHalf = decodeDiscordFrames(frame.subarray(0, 11));
  assert.lengthOf(firstHalf.frames, 0);
  assert.equal(firstHalf.rest.toString("hex"), frame.subarray(0, 11).toString("hex"));

  const secondHalf = decodeDiscordFrames(Buffer.concat([firstHalf.rest, frame.subarray(11)]));
  assert.lengthOf(secondHalf.frames, 1);
  assert.deepEqual(JSON.parse(secondHalf.frames[0]!.data), { evt: "READY" });
  assert.equal(secondHalf.rest.length, 0);
});

it("waits for the header before reading a frame", () => {
  const partial = decodeDiscordFrames(encodeDiscordFrame(1, { evt: "READY" }).subarray(0, 4));
  assert.lengthOf(partial.frames, 0);
  assert.equal(partial.rest.length, 4);
});

it("offers every Discord IPC slot", () => {
  const windows = discordIpcPathCandidates("win32", {});
  assert.lengthOf(windows, 10);
  assert.equal(windows[0], "\\\\?\\pipe\\discord-ipc-0");
  assert.equal(windows[9], "\\\\?\\pipe\\discord-ipc-9");

  const unix = discordIpcPathCandidates("linux", { XDG_RUNTIME_DIR: "/run/user/1000" });
  assert.lengthOf(unix, 10);
  assert.equal(unix[0], "/run/user/1000/discord-ipc-0");
  assert.equal(unix[9], "/run/user/1000/discord-ipc-9");
});

it("falls back through the Unix runtime directories", () => {
  assert.equal(
    discordIpcPathCandidates("darwin", { TMPDIR: "/var/folders/t/" })[0],
    "/var/folders/t/discord-ipc-0",
  );
  // macOS sets TMPDIR; an unrelated XDG_RUNTIME_DIR must not win there.
  assert.equal(
    discordIpcPathCandidates("darwin", {
      TMPDIR: "/var/folders/t/",
      XDG_RUNTIME_DIR: "/run/user/1000",
    })[0],
    "/var/folders/t/discord-ipc-0",
  );
  assert.equal(discordIpcPathCandidates("linux", { TMP: "/var/tmp" })[0], "/var/tmp/discord-ipc-0");
  assert.equal(discordIpcPathCandidates("linux", {})[0], "/tmp/discord-ipc-0");
});

it("clears the status when no agent is working", () => {
  assert.isNull(presenceActivity(0, 1_700_000_000_000));
  assert.equal(presenceActivity(1, 1_700_000_000_000)?.details, "1 agent working");
  assert.equal(presenceActivity(3, 1_700_000_000_000)?.details, "3 agents working");
});

it("builds a public activity with a stable start time", () => {
  const startedAt = 1_700_000_000_123;
  const activity = presenceActivity(2, startedAt);
  assert.deepEqual(activity, {
    details: "2 agents working",
    timestamps: { start: startedAt },
  });
  assert.deepEqual(Object.keys(activity!).sort(), ["details", "timestamps"]);
});

it("only adds an image when one is configured", () => {
  assert.notProperty(presenceActivity(2, 5), "assets");
  assert.deepEqual(presenceActivity(2, 5, "mem"), {
    details: "2 agents working",
    timestamps: { start: 5 },
    assets: { large_image: "mem", large_text: "Mem" },
  });
});

it("only opens a socket when there is a client and something to show", () => {
  assert.isFalse(shouldOpenDiscordConnection("", null));
  assert.isFalse(shouldOpenDiscordConnection("123", null));
  assert.isTrue(shouldOpenDiscordConnection("123", presenceActivity(1, 5)));
});
