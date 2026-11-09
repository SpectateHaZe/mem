import { assert, it } from "@effect/vitest";

import { encodeDiscordFrame, presenceActivity } from "./DiscordPresence.ts";

it("frames messages with a little-endian opcode and length", () => {
  const frame = encodeDiscordFrame(1, { a: 1 });
  assert.equal(frame.readInt32LE(0), 1);
  assert.equal(frame.readInt32LE(4), 7);
  assert.equal(frame.subarray(8).toString(), '{"a":1}');
});

it("clears the status when no agent is working", () => {
  assert.equal(presenceActivity(0), null);
  assert.equal(presenceActivity(1)?.details, "1 agent working");
  assert.equal(presenceActivity(3)?.details, "3 agents working");
});
