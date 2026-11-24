import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";

import {
  addUserFollowUp,
  beginDeliberationTurn,
  buildParallelThinkingPrompt,
  createInitialCowork,
  extractDecision,
  extractUserSummary,
  formatSessionContext,
  nextSpeakerIndex,
  recordDeliberationReply,
  recordParallelThought,
} from "./coworkModerator.ts";

const model = (slug: string): ModelSelection => ({
  instanceId: "claudeAgent" as never,
  model: slug,
});

const makeCowork = (maxRounds = 2) =>
  createInitialCowork({
    sessionThreadId: ThreadId.make("session-1"),
    projectId: ProjectId.make("project-1"),
    topic: "API sync strategy",
    participants: [
      {
        threadId: ThreadId.make("peer-0"),
        label: "Claude",
        role: "Architect",
        modelSelection: model("claude-sonnet"),
        seen: 0,
        status: "idle",
      },
      {
        threadId: ThreadId.make("peer-1"),
        label: "Codex",
        modelSelection: model("gpt-5"),
        seen: 0,
        status: "idle",
      },
      {
        threadId: ThreadId.make("peer-2"),
        label: "Gemini",
        role: "Skeptic",
        modelSelection: model("gemini-pro"),
        seen: 0,
        status: "idle",
      },
    ],
    maxRounds,
    message: "Should we use WebSockets or SSE?",
    messageId: "m-0",
    now: "2026-11-24T12:00:00Z",
  });

it("starts in parallel thinking phase when maxRounds >= 2 and gives each peer independent prompts", () => {
  const session = makeCowork(2);
  assert.equal(session.phase, "thinking");
  assert.equal(session.speakerIndex, null);
  assert.equal(session.turnsLeft, 3);
  assert.isTrue(session.participants.every((p) => p.status === "thinking" && p.seen === 1));

  const prompt = buildParallelThinkingPrompt(session, 0, 'Selected session: "Auth refactor"');
  assert.include(prompt, "equal peer");
  assert.include(prompt, "Architect");
  assert.include(prompt, "Selected session");
  assert.include(prompt, "Should we use WebSockets or SSE?");
});

it("transitions from parallel thinking to deliberation only after all peers finish", () => {
  let session = makeCowork(2);
  session = recordParallelThought(
    session,
    0,
    "**Claude:** WebSockets are bidirectional.",
    "t1",
    "m1",
  );
  assert.equal(session.phase, "thinking");
  assert.equal(session.participants[0]?.status, "done");

  session = recordParallelThought(session, 2, "SSE is simpler for one-way streams.", "t2", "m2");
  assert.equal(session.phase, "thinking");

  session = recordParallelThought(session, 1, "Hybrid: WS for commands, SSE for logs.", "t3", "m3");
  assert.equal(session.phase, "deliberating");
  assert.equal(session.currentRound, 2);
  assert.equal(session.speakerIndex, 0);
  assert.equal(session.turnsLeft, 3);
});

it("delivers all unseen peer thoughts, routes @mentions, and settles on a decision", () => {
  let session = makeCowork(2);
  session = recordParallelThought(session, 0, "Use WS.", "t1", "m1");
  session = recordParallelThought(session, 1, "Use SSE.", "t2", "m2");
  session = recordParallelThought(session, 2, "Check latency.", "t3", "m3");

  const turn0 = beginDeliberationTurn(session, 0, "");
  assert.include(turn0.prompt, "[Codex]: Use SSE.");
  assert.include(turn0.prompt, "[Gemini]: Check latency.");
  assert.notInclude(turn0.prompt, "[Claude]: Use WS.");

  session = recordDeliberationReply(turn0.session, 0, "What do you think @Gemini?", "t4", "m4");
  assert.equal(session.phase, "deliberating");
  assert.equal(session.speakerIndex, 2);

  const turn2 = beginDeliberationTurn(session, 2, "");
  session = recordDeliberationReply(
    turn2.session,
    2,
    "WS is worth it for @Codex commands.",
    "t5",
    "m5",
  );
  assert.equal(session.speakerIndex, 1);

  const turn1 = beginDeliberationTurn(session, 1, "");
  assert.include(turn1.prompt, "This is the final turn");
  session = recordDeliberationReply(
    turn1.session,
    1,
    "Agreed.\nDecision: Use WebSockets for bidirectional RPC.",
    "t6",
    "m6",
  );
  assert.equal(session.phase, "decided");
  assert.equal(session.speakerIndex, null);
  assert.equal(session.decision, "Use WebSockets for bidirectional RPC.");
});

it("follows @mentions without matching self or email addresses", () => {
  const session = makeCowork(1);
  assert.equal(nextSpeakerIndex(session, 0, "Ask @gemini"), 2);
  assert.equal(nextSpeakerIndex(session, 0, "Note to @Claude"), 1);
  assert.equal(nextSpeakerIndex(session, 0, "ping a@gemini.dev"), 1);
});

it("lets a follow-up reopen deliberation or preserve an in-flight turn budget", () => {
  const running = beginDeliberationTurn(makeCowork(1), 0, "").session;
  const followed = addUserFollowUp(running, "What about reconnects?", "t1", "m1");
  assert.equal(followed.turnsLeft, 4);

  const afterReply = recordDeliberationReply(followed, 0, "Reconnect with backoff.", "t2", "m2");
  assert.equal(afterReply.turnsLeft, 3);
  assert.equal(afterReply.phase, "deliberating");

  const decided = { ...afterReply, phase: "decided" as const, speakerIndex: null, turnsLeft: 0 };
  const reopened = addUserFollowUp(decided, "@Codex check backoff", "t3", "m3");
  assert.equal(reopened.phase, "deliberating");
  assert.equal(reopened.speakerIndex, 1);
  assert.equal(reopened.turnsLeft, 3);
});

it("extracts user summaries and decision lines and formats bounded session context", () => {
  assert.equal(extractDecision("Summary\n**Decision:** Ship Cowork"), "Ship Cowork");
  assert.equal(extractDecision("My Decision: pending"), null);
  assert.equal(extractUserSummary("For you: Keep it short.\nDetailed points."), "Keep it short.");

  let session = makeCowork(2);
  session = recordParallelThought(
    session,
    0,
    "For you: Use WS for live updates.\nWS supports bidirectional RPC cleanly.",
    "t1",
    "m1",
  );
  const thought = session.transcript[1]!;
  assert.equal(thought.summary, "Use WS for live updates.");
  assert.equal(thought.text, "WS supports bidirectional RPC cleanly.");

  const ctx = formatSessionContext({
    title: "Refactor auth",
    branch: "feat/auth",
    messages: [
      { role: "system", text: "ignore me" },
      { role: "user", text: "Fix token refresh" },
      { role: "assistant", text: "Looking at AuthService.ts" },
    ],
  });
  assert.include(ctx, 'Selected session: "Refactor auth" (branch: feat/auth)');
  assert.include(ctx, "[User]: Fix token refresh");
  assert.include(ctx, "[Session]: Looking at AuthService.ts");
  assert.notInclude(ctx, "ignore me");
});
