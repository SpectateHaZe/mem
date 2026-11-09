import { assert, it } from "@effect/vitest";
import type { Room } from "@t3tools/contracts";

import {
  addAgentReply,
  addUserMessage,
  beginTurn,
  nextSpeakerIndex,
  subagentFinishedNote,
} from "./roomModerator.ts";

const makeRoom = (): Room =>
  ({
    id: "room",
    projectId: "project",
    title: "Sync design",
    participants: ["Claude", "DeepSeek", "Codex"].map((label, index) => ({
      threadId: `thread-${index}`,
      label,
      seen: 0,
    })),
    transcript: [],
    status: "idle",
    speakerIndex: null,
    turnsLeft: 0,
    maxRounds: 1,
  }) as unknown as Room;

it("follows an @mention and otherwise goes round the table", () => {
  const room = makeRoom();
  assert.equal(nextSpeakerIndex(room, 0, "What do you think @codex?"), 2);
  assert.equal(nextSpeakerIndex(room, 2, "No mentions here"), 0);
  assert.equal(nextSpeakerIndex(room, 0, "Note to @Claude myself"), 1);
  assert.equal(nextSpeakerIndex(room, 0, "email me at a@codex.dev"), 1);
});

it("gives the user a fresh budget and lets them pick who answers first", () => {
  const room = addUserMessage(makeRoom(), "@DeepSeek cost?", "t");
  assert.equal(room.turnsLeft, 3);
  assert.equal(room.status, "running");
  assert.equal(room.speakerIndex, 1);
});

it("stops after the turn budget and never exceeds it", () => {
  let room = addUserMessage(makeRoom(), "Question", "t");
  for (const speaker of [0, 1]) {
    room = addAgentReply(beginTurn(room, speaker).room, speaker, "reply", "t");
    assert.equal(room.status, "running");
  }
  room = addAgentReply(beginTurn(room, 2).room, 2, "Decision: yes", "t");
  assert.equal(room.status, "idle");
  assert.equal(room.speakerIndex, null);
  assert.equal(room.turnsLeft, 0);
});

it("tells a lead agent how to reach its helpers and never asks it to wrap up", () => {
  const room = {
    ...makeRoom(),
    mode: "lead",
    participants: makeRoom().participants.slice(0, 1),
    maxRounds: 1,
    helpers: [{ label: "Cheap", modelSelection: { instanceId: "opencode", model: "free-1" } }],
  } as unknown as Room;
  const { prompt } = beginTurn(addUserMessage(room, "Question", "t"), 0);
  assert.include(prompt, 'providerInstanceId "opencode", model "free-1"');
  assert.notInclude(prompt, "Decision:");
});

it("sends each agent only what it has not seen and asks the last speaker to decide", () => {
  let room = addUserMessage(makeRoom(), "Question", "t");
  const first = beginTurn(room, 0);
  assert.include(first.prompt, "You are Claude");
  assert.include(first.prompt, "[You]: Question");
  room = addAgentReply(first.room, 0, "**Claude:** My answer", "t");
  room = addAgentReply(beginTurn(room, 1).room, 1, "Mine differs", "t");

  const last = beginTurn(room, 2);
  assert.include(last.prompt, "[Claude]: My answer");
  assert.include(last.prompt, "Decision:");

  const again = beginTurn(addUserMessage(last.room, "Follow up", "t"), 2);
  assert.notInclude(again.prompt, "[Claude]: My answer");
  assert.include(again.prompt, "[You]: Follow up");
  assert.notInclude(again.prompt, "You are Codex");
});

it("reports a subagent's outcome to its parent", () => {
  assert.strictEqual(
    subagentFinishedNote("Haiku", "completed", " Done. "),
    "Subagent (Haiku) finished.\n\nDone.",
  );
  assert.strictEqual(
    subagentFinishedNote("Haiku", "failed", ""),
    "Subagent (Haiku) stopped early (failed). It left no reply.",
  );
  const long = subagentFinishedNote("Haiku", "completed", "x".repeat(30_000));
  assert.include(long, "Result cut off");
  assert.isBelow(long.length, 20_200);
});
