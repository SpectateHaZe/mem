import type { CoworkMessage, CoworkSession } from "@t3tools/contracts";

const USER_SPEAKER = "You";
const DECISION_LINE = /^[ \t]*\**Decision:\**[ \t]*(.+?)\**[ \t]*$/im;
const MAX_SESSION_CONTEXT_MESSAGES = 8;
const MAX_SESSION_CONTEXT_MESSAGE_CHARS = 600;
const MAX_SESSION_CONTEXT_CHARS = 3_600;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentionPattern = (label: string) =>
  new RegExp(`(^|\\s)@${escapeRegExp(label)}(?![\\w-])`, "i");

export const extractDecision = (text: string): string | null =>
  DECISION_LINE.exec(text)?.[1]?.trim() ?? null;

export const latestDecision = (transcript: ReadonlyArray<CoworkMessage>): string | undefined => {
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

/** The first peer named with an `@`, excluding the current speaker. */
export const mentionedPeerIndex = (
  session: Pick<CoworkSession, "participants">,
  text: string,
  exceptIndex: number | null,
): number | null => {
  const index = session.participants.findIndex(
    (participant, i) => i !== exceptIndex && mentionPattern(participant.label).test(text),
  );
  return index === -1 ? null : index;
};

export const nextSpeakerIndex = (
  session: Pick<CoworkSession, "participants">,
  lastIndex: number,
  text: string,
): number =>
  mentionedPeerIndex(session, text, lastIndex) ?? (lastIndex + 1) % session.participants.length;

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
  for (const message of recent) {
    const trimmed = message.text.trim();
    const snippet =
      trimmed.length > MAX_SESSION_CONTEXT_MESSAGE_CHARS
        ? `${trimmed.slice(0, MAX_SESSION_CONTEXT_MESSAGE_CHARS)}…`
        : trimmed;
    const line = `[${message.role === "user" ? "User" : "Session"}]: ${snippet}`;
    if (totalChars + line.length > MAX_SESSION_CONTEXT_CHARS && lines.length > 0) break;
    lines.push(line);
    totalChars += line.length;
  }

  return [
    `Selected session: "${input.title}"${input.branch ? ` (branch: ${input.branch})` : ""}`,
    ...(lines.length > 0 ? ["Recent session conversation:", ...lines] : []),
  ].join("\n");
}

const equalPeerPreamble = (
  session: Pick<CoworkSession, "topic" | "participants">,
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
    "Every agent in this cowork is an equal peer; none of you is a subagent or lead. Inspect workspace files if needed to ground your reasoning, but do not edit files unless the user explicitly asks you to.",
  ].join(" ");
};

export function createInitialCowork(input: {
  readonly sessionThreadId: CoworkSession["sessionThreadId"];
  readonly projectId: CoworkSession["projectId"];
  readonly topic: string;
  readonly participants: CoworkSession["participants"];
  readonly maxRounds: number;
  readonly message: string;
  readonly messageId: string;
  readonly now: string;
}): CoworkSession {
  const parallelFirst = input.maxRounds >= 2;
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
      : input.participants.length,
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
    sessionContext || null,
    `[You]: ${userMessage}`,
    "Round 1 (independent thinking): analyze the problem on your own before seeing your peers' takes. Share your concrete proposal, key reasoning, and trade-offs concisely.",
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
  const text = stripSpeakerPrefix(speaker.label, reply);
  const transcript: ReadonlyArray<CoworkMessage> = [
    ...session.transcript,
    { id: messageId, speaker: speaker.label, kind: "thought", round: 1, text, at },
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
    speaker.seen === 0 && sessionContext ? sessionContext : null,
    unseen.length > 0 ? unseen.join("\n\n") : "Please continue the deliberation.",
    session.turnsLeft <= 1
      ? 'This is the final turn. Synthesize where the team landed in one clear line starting with "Decision:", and note any remaining trade-off or dissent.'
      : "Discuss as equals: evaluate your peers' reasoning, challenge weak assumptions, answer any @questions addressed to you, and write @Name to ask a specific peer. Include a line starting with \"Decision:\" once you propose or agree on the team's answer.",
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
  const text = stripSpeakerPrefix(speaker.label, reply);
  const transcript: ReadonlyArray<CoworkMessage> = [
    ...session.transcript,
    {
      id: messageId,
      speaker: speaker.label,
      kind: "deliberation",
      round: session.currentRound,
      text,
      at,
    },
  ];
  const turnsLeft = Math.max(0, session.turnsLeft - 1);
  const done = turnsLeft <= 0;
  const participants = session.participants.map((participant, index) =>
    index === speakerIndex ? { ...participant, status: "done" as const } : participant,
  );
  const decision = extractDecision(text) ?? session.decision ?? latestDecision(transcript);
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
    speakerIndex: done ? null : nextSpeakerIndex(session, speakerIndex, text),
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
