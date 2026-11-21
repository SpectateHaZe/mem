import { assert, it } from "@effect/vitest";
import {
  DEFAULT_DISCORD_PRESENCE_SETTINGS,
  DISCORD_GITHUB_BUTTON,
  DISCORD_WEBSITE_BUTTON,
} from "@t3tools/contracts/settings";

import {
  decodeDiscordFrames,
  discordIpcPathCandidates,
  encodeDiscordFrame,
  presenceActivity,
  renderDiscordTemplate,
  resolvePresenceState,
  shouldOpenDiscordConnection,
} from "./DiscordPresence.ts";

const agents = (liveAgents: number) =>
  resolvePresenceState({ liveAgents, autonomous: false, autonomousSessions: 0 });
const autonomous = (liveAgents: number, autonomousSessions = 1) =>
  resolvePresenceState({ liveAgents, autonomous: true, autonomousSessions });

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
  assert.isNull(presenceActivity(agents(0), 1_700_000_000_000));
  assert.equal(presenceActivity(agents(1), 1_700_000_000_000)?.details, "1 agent working");
  assert.equal(presenceActivity(agents(3), 1_700_000_000_000)?.details, "3 agents working");
});

it("picks autonomous, active, or no presence from what is actually happening", () => {
  // Mem is driving a claimed session: autonomous, whether or not a turn is running right now.
  assert.deepEqual(
    resolvePresenceState({ liveAgents: 2, autonomous: true, autonomousSessions: 3 }),
    { kind: "autonomous", agents: 2 },
  );
  assert.deepEqual(
    resolvePresenceState({ liveAgents: 0, autonomous: true, autonomousSessions: 1 }),
    { kind: "autonomous", agents: 0 },
  );
  // Autonomous mode with nothing claimed is idle, even if a watching thread keeps the count high.
  assert.deepEqual(
    resolvePresenceState({ liveAgents: 4, autonomous: true, autonomousSessions: 0 }),
    { kind: "agents", agents: 4 },
  );
  // Without autonomous mode, only running agents matter.
  assert.deepEqual(
    resolvePresenceState({ liveAgents: 2, autonomous: false, autonomousSessions: 3 }),
    { kind: "agents", agents: 2 },
  );
  // Nothing running and nothing claimed clears the card.
  assert.deepEqual(
    resolvePresenceState({ liveAgents: 0, autonomous: false, autonomousSessions: 0 }),
    { kind: "none", agents: 0 },
  );
  assert.isNull(
    presenceActivity(
      resolvePresenceState({
        liveAgents: 0,
        autonomous: true,
        autonomousSessions: 0,
      }),
      1_700_000_000_000,
    ),
  );
});

it("says Mem is working autonomously, with the live agent count", () => {
  const busy = presenceActivity(autonomous(2), 1_700_000_000_000, { modelNames: ["gpt-5.4"] });
  assert.equal(busy?.details, "Working autonomously · 2 agents");
  assert.equal(busy?.state, "gpt-5.4");

  // Between turns Mem still owns claimed sessions, so the line stands without claiming agents.
  const betweenTurns = presenceActivity(autonomous(0), 1_700_000_000_000, {
    modelNames: ["gpt-5.4"],
  });
  assert.equal(betweenTurns?.details, "Working autonomously");

  // The owner's own words replace the default.
  const custom = presenceActivity(autonomous(1), 1_700_000_000_000, {
    presence: { ...DEFAULT_DISCORD_PRESENCE_SETTINGS, autonomousText: "Heads down" },
  });
  assert.equal(custom?.details, "Heads down · 1 agent");

  // A template that showed the owner's AFK state keeps showing it.
  const away = presenceActivity(autonomous(1), 1_700_000_000_000, { ownerAfk: true });
  assert.equal(away?.details, "Working autonomously · 1 agent · user is afk");

  // Active work that is not autonomous keeps the template.
  assert.equal(presenceActivity(agents(2), 1_700_000_000_000)?.details, "2 agents working");
});

it("claims the owner is away only when idle detection says so", () => {
  const presence = {
    ...DEFAULT_DISCORD_PRESENCE_SETTINGS,
    detailsTemplate: "{mode} · {agents} working",
  };
  const away = presenceActivity(agents(1), 1_700_000_000_000, {
    ownerAfk: true,
    presence,
  });
  assert.equal(away?.details, "user is afk · 1 agent working");

  const present = presenceActivity(agents(1), 1_700_000_000_000, {
    ownerAfk: false,
    presence,
  });
  assert.equal(present?.details, "1 agent working");
});

it("keeps the details count and shows one model in state", () => {
  const activity = presenceActivity(agents(2), 1_700_000_000_000, { modelNames: ["gpt-5.4"] });
  assert.equal(activity?.details, "2 agents working");
  assert.equal(activity?.state, "gpt-5.4");
});

it("summarizes several distinct models as first with n more", () => {
  const activity = presenceActivity(agents(3), 1_700_000_000_000, {
    modelNames: ["gpt-5.4", "claude-sonnet-4", "gpt-5.4"],
  });
  assert.equal(activity?.state, "gpt-5.4 +1 more");
});

it("shows the project name only when the caller passes it", () => {
  const hidden = presenceActivity(agents(1), 1_700_000_000_000, { modelNames: ["gpt-5.4"] });
  assert.equal(hidden?.state, "gpt-5.4");

  const shown = presenceActivity(agents(1), 1_700_000_000_000, {
    modelNames: ["gpt-5.4"],
    projectNames: ["My Private Project"],
  });
  assert.equal(shown?.state, "My Private Project · gpt-5.4");
});

it("summarizes several distinct projects as first with n more", () => {
  const activity = presenceActivity(agents(2), 1_700_000_000_000, {
    projectNames: ["Alpha", "Beta", "Alpha"],
  });
  assert.equal(activity?.state, "Alpha +1 more");
});

it("truncates long model and project names to Discord's limits", () => {
  const longModel = "b".repeat(500);
  const longProject = "p".repeat(500);
  const one = presenceActivity(agents(1), 1_700_000_000_000, { modelNames: [longModel] });
  assert.equal(one?.state, `${"b".repeat(59)}…`);
  assert.equal(one?.state?.length, 60);

  const both = presenceActivity(agents(1), 1_700_000_000_000, {
    modelNames: [longModel],
    projectNames: [longProject],
  });
  const state = both?.state ?? "";
  assert.isAtMost(state.length, 128);
  assert.isAtLeast(state.length, 2);
  assert.isTrue(state.startsWith(`${"p".repeat(59)}… · ${"b".repeat(59)}…`));

  // Two "+n more" parts overflow the composed field, so its own truncation kicks in.
  const maximal = presenceActivity(agents(1), 1_700_000_000_000, {
    modelNames: [longModel, "m"],
    projectNames: [longProject, "q"],
  });
  const maximalState = maximal?.state ?? "";
  assert.equal(maximalState.length, 128);
  assert.isTrue(maximalState.endsWith("…"));
});

it("truncates astral names on a whole character", () => {
  const emoji = "🐈";
  const one = presenceActivity(agents(1), 1_700_000_000_000, { modelNames: [emoji.repeat(500)] });
  assert.equal(one?.state, `${emoji.repeat(29)}…`);

  // Overflow past the composed field also lands mid-pair, so both cuts stay whole.
  const maximal = presenceActivity(agents(1), 1_700_000_000_000, {
    modelNames: [emoji.repeat(500), "m"],
    projectNames: [emoji.repeat(500), "q"],
  });
  const state = maximal?.state ?? "";
  assert.isAtMost(state.length, 128);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.isFalse(loneSurrogate.test(state));
});

it("omits state when the composed text is too short for Discord", () => {
  const empty = presenceActivity(agents(1), 1_700_000_000_000, {});
  assert.notProperty(empty, "state");

  const tooShort = presenceActivity(agents(1), 1_700_000_000_000, { modelNames: ["x"] });
  assert.notProperty(tooShort, "state");

  const blankIgnored = presenceActivity(agents(1), 1_700_000_000_000, {
    modelNames: ["  "],
    projectNames: ["My Project"],
  });
  assert.equal(blankIgnored?.state, "My Project");

  // Two short parts together are long enough to keep.
  const pair = presenceActivity(agents(1), 1_700_000_000_000, {
    modelNames: ["x"],
    projectNames: ["x"],
  });
  assert.equal(pair?.state, "x · x");
});

it("builds a public activity with a stable start time", () => {
  const startedAt = 1_700_000_000_123;
  const activity = presenceActivity(agents(2), startedAt);
  assert.deepEqual(activity, {
    details: "2 agents working",
    timestamps: { start: startedAt },
    buttons: [DISCORD_WEBSITE_BUTTON, DISCORD_GITHUB_BUTTON],
  });
  assert.deepEqual(Object.keys(activity!).sort(), ["buttons", "details", "timestamps"]);
});

it("only adds an image when one is configured", () => {
  assert.notProperty(presenceActivity(agents(2), 5), "assets");
  assert.deepEqual(
    presenceActivity(agents(2), 5, {
      presence: { ...DEFAULT_DISCORD_PRESENCE_SETTINGS, largeImageKey: "mem" },
    }),
    {
      details: "2 agents working",
      timestamps: { start: 5 },
      buttons: [DISCORD_WEBSITE_BUTTON, DISCORD_GITHUB_BUTTON],
      assets: { large_image: "mem", large_text: "Mem" },
    },
  );
});

it("keeps every configured image and its own text", () => {
  const activity = presenceActivity(agents(1), 5, {
    presence: {
      ...DEFAULT_DISCORD_PRESENCE_SETTINGS,
      largeImageKey: "mem",
      largeImageText: "Working",
      smallImageKey: "busy",
      smallImageText: "Live",
    },
  });
  assert.deepEqual(activity?.assets, {
    large_image: "mem",
    large_text: "Working",
    small_image: "busy",
    small_text: "Live",
  });
});

it("drops a line the owner emptied and hides the timer when asked", () => {
  const presence = {
    ...DEFAULT_DISCORD_PRESENCE_SETTINGS,
    detailsTemplate: "",
    stateTemplate: "   ",
    showElapsedTimer: false,
  };
  assert.isNull(presenceActivity(agents(2), 5, { presence }));
  assert.deepEqual(
    presenceActivity(agents(2), 5, { presence: { ...presence, detailsTemplate: "Busy" } }),
    {
      details: "Busy",
      buttons: [DISCORD_WEBSITE_BUTTON, DISCORD_GITHUB_BUTTON],
    },
  );
});

it("links to the Mem website and repository by default, and drops each when hidden", () => {
  assert.deepEqual(presenceActivity(agents(1), 5)?.buttons, [
    { label: "Mem website", url: "https://spectatehaze.github.io/mem-site/" },
    { label: "Mem on GitHub", url: "https://github.com/SpectateHaZe/mem" },
  ]);
  assert.deepEqual(
    presenceActivity(agents(1), 5, {
      presence: { ...DEFAULT_DISCORD_PRESENCE_SETTINGS, showGithubButton: false },
    })?.buttons,
    [DISCORD_WEBSITE_BUTTON],
  );
  assert.deepEqual(
    presenceActivity(agents(1), 5, {
      presence: { ...DEFAULT_DISCORD_PRESENCE_SETTINGS, showWebsiteButton: false },
    })?.buttons,
    [DISCORD_GITHUB_BUTTON],
  );
  assert.notProperty(
    presenceActivity(agents(1), 5, {
      presence: {
        ...DEFAULT_DISCORD_PRESENCE_SETTINGS,
        showGithubButton: false,
        showWebsiteButton: false,
      },
    })!,
    "buttons",
  );
});

it("gives a custom button the website's slot so both built-ins stay visible", () => {
  const base = {
    ...DEFAULT_DISCORD_PRESENCE_SETTINGS,
    customButtonUrl: "https://mem.example/docs",
  };
  assert.deepEqual(
    presenceActivity(agents(1), 5, {
      presence: { ...base, customButtonLabel: "  Docs  " },
    })?.buttons,
    [{ label: "Docs", url: "https://mem.example/docs" }, DISCORD_GITHUB_BUTTON],
  );
  // 32 characters is Discord's ceiling for a label, not one past it.
  const longest = "l".repeat(32);
  assert.deepEqual(
    presenceActivity(agents(1), 5, {
      presence: { ...base, customButtonLabel: longest },
    })?.buttons,
    [{ label: longest, url: "https://mem.example/docs" }, DISCORD_GITHUB_BUTTON],
  );
  // The custom button stands alone when the GitHub one is hidden.
  assert.deepEqual(
    presenceActivity(agents(1), 5, {
      presence: { ...base, customButtonLabel: "Docs", showGithubButton: false },
    })?.buttons,
    [{ label: "Docs", url: "https://mem.example/docs" }],
  );
});

it("drops an invalid custom button instead of the whole card", () => {
  const base = {
    ...DEFAULT_DISCORD_PRESENCE_SETTINGS,
    customButtonLabel: "Docs",
    customButtonUrl: "https://mem.example",
  };
  for (const customButtonUrl of ["", "http://mem.example", "mem.example", "javascript:alert(1)"]) {
    const activity = presenceActivity(agents(1), 5, { presence: { ...base, customButtonUrl } });
    assert.deepEqual(activity?.buttons, [DISCORD_WEBSITE_BUTTON, DISCORD_GITHUB_BUTTON]);
    assert.equal(activity?.details, "1 agent working");
  }
  for (const customButtonLabel of ["", "   ", "l".repeat(33)]) {
    assert.deepEqual(
      presenceActivity(agents(1), 5, { presence: { ...base, customButtonLabel } })?.buttons,
      [DISCORD_WEBSITE_BUTTON, DISCORD_GITHUB_BUTTON],
    );
  }
});

it("clears the card when the owner turns presence off", () => {
  assert.isNull(
    presenceActivity(agents(2), 5, {
      presence: { ...DEFAULT_DISCORD_PRESENCE_SETTINGS, enabled: false },
    }),
  );
});

it("renders the details template with the agent count and its noun", () => {
  const values = { agents: 3, project: "", model: "", mode: "" };
  assert.equal(renderDiscordTemplate("{agents} working", values), "3 agents working");
  assert.equal(
    renderDiscordTemplate("{agents} working", { ...values, agents: 1 }),
    "1 agent working",
  );
});

it("drops empty placeholders instead of leaving a loose separator", () => {
  const values = { agents: 2, project: "Mem", model: "gpt-5.4", mode: "mem in control" };
  assert.equal(renderDiscordTemplate("{project} · {model}", { ...values, project: "" }), "gpt-5.4");
  assert.equal(
    renderDiscordTemplate("{project} · {model}", { ...values, project: "", model: "" }),
    "",
  );
  assert.equal(renderDiscordTemplate("  · {model}  ", values), "gpt-5.4");
  assert.equal(renderDiscordTemplate("{state} · {model}", values), "{state} · gpt-5.4");
  assert.equal(
    renderDiscordTemplate("{mode} · {agents} working", { ...values, mode: "" }),
    "2 agents working",
  );
});

it("trims and collapses the whitespace around placeholders", () => {
  const values = { agents: 1, project: " My Project ", model: " gpt-5.4 ", mode: "" };
  assert.equal(renderDiscordTemplate("  {project}   ·   {model} ", values), "My Project · gpt-5.4");
});

it("truncates a rendered template to Discord's limit", () => {
  const rendered = renderDiscordTemplate("{project}", {
    agents: 0,
    project: "p".repeat(500),
    model: "",
    mode: "",
  });
  assert.equal(rendered.length, 128);
  assert.isTrue(rendered.endsWith("…"));
});

it("only opens a socket when there is a client and something to show", () => {
  assert.isFalse(shouldOpenDiscordConnection("", null));
  assert.isFalse(shouldOpenDiscordConnection("123", null));
  assert.isTrue(shouldOpenDiscordConnection("123", presenceActivity(agents(1), 5)));
});
