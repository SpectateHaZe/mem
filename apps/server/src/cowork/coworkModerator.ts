import type { CoworkMessage, CoworkSession, CoworkStance } from "@t3tools/contracts";

const USER_SPEAKER = "You";
const DECISION_LINE = /^[ \t]*\**Decision:\**[ \t]*(.+?)\**[ \t]*$/im;
const USER_SUMMARY_LINE = /^[ \t]*(?:[-*][ \t]+)?\**(?:For you|Summary):\**[ \t]*(.+?)\**[ \t]*$/im;
const STANCE_LINE = /^[ \t]*\**Stance:\**[ \t]*\**(agree|disagree)\b/gim;
// Only peers that could not fork the session read this transcript, so it stays generous.
const MAX_SESSION_CONTEXT_MESSAGES = 40;
const MAX_SESSION_CONTEXT_MESSAGE_CHARS = 2_000;
const MAX_SESSION_CONTEXT_CHARS = 24_000;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentionPattern = (label: string) =>
  new RegExp(`(^|\\s)@${escapeRegExp(label)}(?![\\w-])`, "i");

export const extractDecision = (text: string): string | null =>
  DECISION_LINE.exec(text)?.[1]?.trim() ?? null;

export const extractUserSummary = (text: string): string | null =>
  USER_SUMMARY_LINE.exec(text)?.[1]?.trim() ?? null;

/** The last `Stance:` line wins, since replies end with it. */
export const extractStance = (text: string): CoworkStance | null => {
  const stance = [...text.matchAll(STANCE_LINE)].at(-1)?.[1]?.toLowerCase();
  return stance === "agree" || stance === "disagree" ? stance : null;
};

/** Every peer agreed in one unbroken run of replies since the user last spoke. */
const consensusReached = (
  participantCount: number,
  transcript: ReadonlyArray<CoworkMessage>,
): boolean => {
  const agreed = new Set<string>();
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.kind !== "deliberation" || entry.stance !== "agree") return false;
    agreed.add(entry.speaker);
    if (agreed.size >= participantCount) return true;
  }
  return false;
};

const latestDecision = (transcript: ReadonlyArray<CoworkMessage>): string | undefined => {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const decision = extractDecision(transcript[index]!.text);
    if (decision !== null) return decision;
  }
  return undefined;
};

/** Strips leading `[Name]:` or `**Name:**` echoes models occasionally prepend. */
const stripSpeakerPrefix = (label: string, reply: string) =>
  reply.replace(new RegExp(`^\\s*[*[]*${escapeRegExp(label)}[\\]:*]+\\s*`, "i"), "").trim() ||
  "(no reply)";

const splitPeerReply = (
  label: string,
  reply: string,
): { readonly text: string; readonly summary?: string; readonly stance?: CoworkStance } => {
  const cleaned = stripSpeakerPrefix(label, reply);
  const summary = extractUserSummary(cleaned);
  const stance = extractStance(cleaned);
  const withStance = stance === null ? {} : { stance };
  if (summary === null) return { text: cleaned, ...withStance };
  const withoutSummary = cleaned.replace(USER_SUMMARY_LINE, "").trim();
  return {
    text: withoutSummary || summary,
    summary,
    ...withStance,
  };
};

/** The first peer named with an `@`, excluding the current speaker. */
const mentionedPeerIndex = (
  session: Pick<CoworkSession, "participants">,
  text: string,
  exceptIndex: number | null,
): number | null => {
  const index = session.participants.findIndex(
    (participant, i) => i !== exceptIndex && mentionPattern(participant.label).test(text),
  );
  return index === -1 ? null : index;
};

/** Code mode is strictly round-robin so each peer reviews the previous peer's edits. */
export const nextSpeakerIndex = (
  session: Pick<CoworkSession, "participants" | "mode">,
  lastIndex: number,
  text: string,
): number =>
  (session.mode === "code" ? null : mentionedPeerIndex(session, text, lastIndex)) ??
  (lastIndex + 1) % session.participants.length;

export function formatSessionContext(input: {
  readonly title: string;
  readonly branch: string | null;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}): string {
  const recent = input.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim() !== "",
    )
    .slice(-MAX_SESSION_CONTEXT_MESSAGES);

  const lines: string[] = [];
  let totalChars = 0;
  // Newest messages matter most, so the budget is spent from the end.
  for (const message of recent.toReversed()) {
    const trimmed = message.text.trim();
    const snippet =
      trimmed.length > MAX_SESSION_CONTEXT_MESSAGE_CHARS
        ? `${trimmed.slice(0, MAX_SESSION_CONTEXT_MESSAGE_CHARS)}…`
        : trimmed;
    const line = `[${message.role === "user" ? "User" : "Session"}]: ${snippet}`;
    if (totalChars + line.length > MAX_SESSION_CONTEXT_CHARS && lines.length > 0) break;
    lines.unshift(line);
    totalChars += line.length;
  }

  return [
    `Selected session: "${input.title}"${input.branch ? ` (branch: ${input.branch})` : ""}`,
    ...(lines.length > 0 ? ["Session conversation:", ...lines] : []),
  ].join("\n");
}

const equalPeerPreamble = (
  session: Pick<CoworkSession, "topic" | "participants" | "mode">,
  speakerIndex: number,
) => {
  const speaker = session.participants[speakerIndex]!;
  const others = session.participants
    .filter((_, index) => index !== speakerIndex)
    .map((participant) =>
      participant.role ? `${participant.label} (${participant.role})` : participant.label,
    );
  return [
    `You are ${speaker.label}${speaker.role ? ` (perspective: ${speaker.role})` : ""}, collaborating as an equal peer with ${others.join(", ")} in a cowork session on "${session.topic}".`,
    speaker.forked === true
      ? "This thread is a fork of the user's session, so the conversation above is your shared context."
      : null,
    "Every agent in this cowork is an equal peer; none of you is a subagent or lead. You all share the session's checkout; run `git status` and `git diff --stat` there to see its current changes.",
    session.mode === "code"
      ? "You are building this together and may edit files. Peers take turns one at a time in that one checkout, so build on each other's work and never revert a peer's change without saying why."
      : "Inspect workspace files if needed to ground your reasoning, but do not edit files unless the user explicitly asks you to.",
    "Keep replies concise and scannable (under ~150 words, short bullets or brief sentences; avoid long walls of text or large code dumps).",
  ]
    .filter((part) => part !== null)
    .join(" ");
};

/** A forked peer already holds the session's conversation. */
const contextFor = (session: CoworkSession, speakerIndex: number, sessionContext: string) =>
  session.participants[speakerIndex]?.forked === true ? null : sessionContext;

const FOR_YOU = 'Start with "For you: <1-2 plain sentences for the user>".';
const STANCE_INSTRUCTION =
  'End with one line "Stance: agree" if you agree with the current proposal, or "Stance: disagree (<why>)".';
const CODE_STANCE_INSTRUCTION =
  'End with one line "Stance: agree" if the change is complete and correct (with a line "Decision: <short summary of what the team built>" just before it), or "Stance: disagree (<what is left>)".';

function deliberationInstruction(session: CoworkSession): string {
  if (session.mode === "code") {
    const firstTurn = !session.transcript.some((entry) => entry.kind === "deliberation");
    return [
      firstTurn
        ? "You go first: propose a short plan, then implement the first piece."
        : "Review what the previous peers changed (run `git diff`), fix any problems, then continue the work.",
      session.turnsLeft <= 1
        ? "This is the final turn, so leave the work in a coherent state."
        : null,
      FOR_YOU,
      CODE_STANCE_INSTRUCTION,
    ]
      .filter((part) => part !== null)
      .join(" ");
  }
  if (session.turnsLeft <= 1) {
    return `This is the final turn. Start with "For you: <1-2 plain sentences summarizing where the team landed for the user>", then add one clear line starting with "Decision:" noting any remaining trade-off or dissent. ${STANCE_INSTRUCTION}`;
  }
  return `Discuss as equals: evaluate your peers' reasoning, challenge weak assumptions, answer @questions to you, and write @Name to address a specific peer. ${FOR_YOU} Keep peer notes brief, and add a line starting with "Decision:" once you propose or agree on the answer. ${STANCE_INSTRUCTION}`;
}

export function createInitialCowork(input: {
  readonly sessionThreadId: CoworkSession["sessionThreadId"];
  readonly projectId: CoworkSession["projectId"];
  readonly topic: string;
  readonly mode: CoworkSession["mode"];
  readonly participants: CoworkSession["participants"];
  readonly maxRounds: number;
  readonly message: string;
  readonly messageId: string;
  readonly now: string;
}): CoworkSession {
  // Code mode never thinks in parallel: concurrent peers would edit one checkout at once.
  const parallelFirst = input.mode === "brainstorm" && input.maxRounds >= 2;
  const userMessage: CoworkMessage = {
    id: input.messageId,
    speaker: USER_SPEAKER,
    kind: "user",
    round: 1,
    text: input.message,
    at: input.now,
  };
  return {
    sessionThreadId: input.sessionThreadId,
    projectId: input.projectId,
    topic: input.topic,
    mode: input.mode,
    participants: input.participants.map((participant) => ({
      ...participant,
      seen: parallelFirst ? 1 : 0,
      status: parallelFirst ? "thinking" : "idle",
    })),
    transcript: [userMessage],
    phase: parallelFirst ? "thinking" : "deliberating",
    speakerIndex: parallelFirst ? null : 0,
    currentRound: 1,
    maxRounds: input.maxRounds,
    turnsLeft: parallelFirst
      ? (input.maxRounds - 1) * input.participants.length
      : (input.mode === "code" ? input.maxRounds : 1) * input.participants.length,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function buildParallelThinkingPrompt(
  session: CoworkSession,
  participantIndex: number,
  sessionContext: string,
): string {
  const userMessage =
    session.transcript.find((entry) => entry.kind === "user")?.text ?? session.topic;
  return [
    equalPeerPreamble(session, participantIndex),
    contextFor(session, participantIndex, sessionContext),
    `[You]: ${userMessage}`,
    'Round 1 (independent thinking): analyze the problem on your own before seeing peers\' takes. Start with a single short line written only for the user: "For you: <1-2 plain sentences summarizing your proposal and why>". Follow with brief technical points for your peers.',
  ]
    .filter((part) => part !== null && part !== "")
    .join("\n\n");
}

export function recordParallelThought(
  session: CoworkSession,
  participantIndex: number,
  reply: string,
  at: string,
  messageId: string,
): CoworkSession {
  const speaker = session.participants[participantIndex]!;
  const { stance: _stance, ...parsed } = splitPeerReply(speaker.label, reply);
  const transcript: ReadonlyArray<CoworkMessage> = [
    ...session.transcript,
    {
      id: messageId,
      speaker: speaker.label,
      kind: "thought",
      round: 1,
      ...parsed,
      at,
    },
  ];
  const participants = session.participants.map((participant, index) =>
    index === participantIndex ? { ...participant, status: "done" as const } : participant,
  );
  const stillThinking = participants.some((participant) => participant.status === "thinking");
  if (stillThinking) {
    return {
      ...session,
      participants,
      transcript,
      updatedAt: at,
    };
  }
  const decision = latestDecision(transcript);
  return {
    ...session,
    participants: participants.map((participant) => ({ ...participant, status: "idle" as const })),
    transcript,
    phase: "deliberating",
    speakerIndex: 0,
    currentRound: Math.min(2, session.maxRounds),
    turnsLeft: Math.max(1, session.turnsLeft),
    ...(decision === undefined ? {} : { decision }),
    updatedAt: at,
  };
}

export function beginDeliberationTurn(
  session: CoworkSession,
  speakerIndex: number,
  sessionContext: string,
): { readonly prompt: string; readonly session: CoworkSession } {
  const speaker = session.participants[speakerIndex]!;
  const unseen = session.transcript
    .slice(speaker.seen)
    .filter((message) => message.speaker !== speaker.label)
    .map((message) => `[${message.speaker}]: ${message.text}`);
  const prompt = [
    speaker.seen === 0 ? equalPeerPreamble(session, speakerIndex) : null,
    speaker.seen === 0 ? contextFor(session, speakerIndex, sessionContext) : null,
    unseen.length > 0 ? unseen.join("\n\n") : "Please continue.",
    deliberationInstruction(session),
  ]
    .filter((part) => part !== null && part !== "")
    .join("\n\n");

  const updated: CoworkSession = {
    ...session,
    speakerIndex,
    participants: session.participants.map((participant, index) =>
      index === speakerIndex
        ? { ...participant, seen: session.transcript.length, status: "thinking" as const }
        : participant,
    ),
  };
  return { prompt, session: updated };
}

export function recordDeliberationReply(
  session: CoworkSession,
  speakerIndex: number,
  reply: string,
  at: string,
  messageId: string,
): CoworkSession {
  const speaker = session.participants[speakerIndex]!;
  const parsed = splitPeerReply(speaker.label, reply);
  const transcript: ReadonlyArray<CoworkMessage> = [
    ...session.transcript,
    {
      id: messageId,
      speaker: speaker.label,
      kind: "deliberation",
      round: session.currentRound,
      ...parsed,
      at,
    },
  ];
  const turnsLeft = consensusReached(session.participants.length, transcript)
    ? 0
    : Math.max(0, session.turnsLeft - 1);
  const done = turnsLeft <= 0;
  const participants = session.participants.map((participant, index) =>
    index === speakerIndex ? { ...participant, status: "done" as const } : participant,
  );
  const decision = extractDecision(parsed.text) ?? session.decision ?? latestDecision(transcript);
  const nextRound = done
    ? session.currentRound
    : Math.min(
        session.maxRounds,
        Math.max(
          session.currentRound,
          session.maxRounds - Math.floor((turnsLeft - 1) / session.participants.length),
        ),
      );
  return {
    ...session,
    participants,
    transcript,
    turnsLeft,
    currentRound: nextRound,
    phase: done ? "decided" : "deliberating",
    speakerIndex: done ? null : nextSpeakerIndex(session, speakerIndex, parsed.text),
    ...(decision === undefined ? {} : { decision }),
    updatedAt: at,
  };
}

export function addUserFollowUp(
  { note: _note, pausedFrom: _pausedFrom, ...session }: CoworkSession,
  text: string,
  at: string,
  messageId: string,
): CoworkSession {
  const userMessage: CoworkMessage = {
    id: messageId,
    speaker: USER_SPEAKER,
    kind: "user",
    round: session.currentRound,
    text,
    at,
  };
  const transcript = [...session.transcript, userMessage];
  if (session.phase === "thinking") {
    return {
      ...session,
      transcript,
      turnsLeft: Math.max(session.turnsLeft, session.participants.length),
      updatedAt: at,
    };
  }
  const wasDeliberating = session.phase === "deliberating";
  return {
    ...session,
    transcript,
    phase: "deliberating",
    turnsLeft: session.participants.length + (wasDeliberating ? 1 : 0),
    speakerIndex: wasDeliberating
      ? session.speakerIndex
      : (mentionedPeerIndex(session, text, null) ?? 0),
    updatedAt: at,
  };
}
