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

it("says Mem is in control while the overseer is on, even with no thread running", () => {
  assert.isNull(presenceActivity(0, 1_700_000_000_000));
  const idle = presenceActivity(0, 1_700_000_000_000, { overseerInControl: true });
  assert.equal(idle?.details, "Mem is in control");
  assert.equal(idle?.state, "mem in control");

  const busy = presenceActivity(2, 1_700_000_000_000, {
    overseerInControl: true,
    modelNames: ["gpt-5.4"],
  });
  assert.equal(busy?.details, "Mem is in control");
  assert.equal(busy?.state, "mem in control · 2 working");
});

it("claims the owner is away only when idle detection says so", () => {
  const away = presenceActivity(1, 1_700_000_000_000, {
    overseerInControl: true,
    ownerAfk: true,
  });
  assert.equal(away?.state, "user is afk · mem in control · 1 working");

  const present = presenceActivity(1, 1_700_000_000_000, {
    overseerInControl: true,
    ownerAfk: false,
  });
  assert.notInclude(present?.state ?? "", "afk");
});

it("keeps the details count and shows one model in state", () => {
  const activity = presenceActivity(2, 1_700_000_000_000, { modelNames: ["gpt-5.4"] });
  assert.equal(activity?.details, "2 agents working");
  assert.equal(activity?.state, "gpt-5.4");
});

it("summarizes several distinct models as first with n more", () => {
  const activity = presenceActivity(3, 1_700_000_000_000, {
    modelNames: ["gpt-5.4", "claude-sonnet-4", "gpt-5.4"],
  });
  assert.equal(activity?.state, "gpt-5.4 +1 more");
});

it("shows the project name only when the caller passes it", () => {
  const hidden = presenceActivity(1, 1_700_000_000_000, { modelNames: ["gpt-5.4"] });
  assert.equal(hidden?.state, "gpt-5.4");

  const shown = presenceActivity(1, 1_700_000_000_000, {
    modelNames: ["gpt-5.4"],
    projectNames: ["My Private Project"],
  });
  assert.equal(shown?.state, "My Private Project · gpt-5.4");
});

it("summarizes several distinct projects as first with n more", () => {
  const activity = presenceActivity(2, 1_700_000_000_000, {
    projectNames: ["Alpha", "Beta", "Alpha"],
  });
  assert.equal(activity?.state, "Alpha +1 more");
});

it("truncates long model and project names to Discord's limits", () => {
  const longModel = "b".repeat(500);
  const longProject = "p".repeat(500);
  const one = presenceActivity(1, 1_700_000_000_000, { modelNames: [longModel] });
  assert.equal(one?.state, `${"b".repeat(59)}…`);
  assert.equal(one?.state?.length, 60);

  const both = presenceActivity(1, 1_700_000_000_000, {
    modelNames: [longModel],
    projectNames: [longProject],
  });
  const state = both?.state ?? "";
  assert.isAtMost(state.length, 128);
  assert.isAtLeast(state.length, 2);
  assert.isTrue(state.startsWith(`${"p".repeat(59)}… · ${"b".repeat(59)}…`));

  // Two "+n more" parts overflow the composed field, so its own truncation kicks in.
  const maximal = presenceActivity(1, 1_700_000_000_000, {
    modelNames: [longModel, "m"],
    projectNames: [longProject, "q"],
  });
  const maximalState = maximal?.state ?? "";
  assert.equal(maximalState.length, 128);
  assert.isTrue(maximalState.endsWith("…"));
});

it("truncates astral names on a whole character", () => {
  const emoji = "🐈";
  const one = presenceActivity(1, 1_700_000_000_000, { modelNames: [emoji.repeat(500)] });
  assert.equal(one?.state, `${emoji.repeat(29)}…`);

  // Overflow past the composed field also lands mid-pair, so both cuts stay whole.
  const maximal = presenceActivity(1, 1_700_000_000_000, {
    modelNames: [emoji.repeat(500), "m"],
    projectNames: [emoji.repeat(500), "q"],
  });
  const state = maximal?.state ?? "";
  assert.isAtMost(state.length, 128);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.isFalse(loneSurrogate.test(state));
});

it("omits state when the composed text is too short for Discord", () => {
  const empty = presenceActivity(1, 1_700_000_000_000, {});
  assert.notProperty(empty, "state");

  const tooShort = presenceActivity(1, 1_700_000_000_000, { modelNames: ["x"] });
  assert.notProperty(tooShort, "state");

  const blankIgnored = presenceActivity(1, 1_700_000_000_000, {
    modelNames: ["  "],
    projectNames: ["My Project"],
  });
  assert.equal(blankIgnored?.state, "My Project");

  // Two short parts together are long enough to keep.
  const pair = presenceActivity(1, 1_700_000_000_000, { modelNames: ["x"], projectNames: ["x"] });
  assert.equal(pair?.state, "x · x");
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
  assert.deepEqual(presenceActivity(2, 5, { largeImageKey: "mem" }), {
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
