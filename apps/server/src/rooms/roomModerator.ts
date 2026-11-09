import type { OrchestrationV2Run, Room, RoomMessage } from "@t3tools/contracts";

export const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const USER_SPEAKER = "You";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentionPattern = (label: string) =>
  new RegExp(`(^|\\s)@${escapeRegExp(label)}(?![\\w-])`, "i");

/** The first agent named with an @, other than the one speaking. */
const mentionedIndex = (room: Room, text: string, exceptIndex: number | null) => {
  const index = room.participants.findIndex(
    (participant, i) => i !== exceptIndex && mentionPattern(participant.label).test(text),
  );
  return index === -1 ? null : index;
};

export const nextSpeakerIndex = (room: Room, lastIndex: number, text: string) =>
  mentionedIndex(room, text, lastIndex) ?? (lastIndex + 1) % room.participants.length;

export const addUserMessage = ({ note: _note, ...room }: Room, text: string, at: string): Room => ({
  ...room,
  transcript: [...room.transcript, { speaker: USER_SPEAKER, text, at }],
  turnsLeft: room.maxRounds * room.participants.length,
  status: "running",
  speakerIndex:
    room.status === "running" ? room.speakerIndex : (mentionedIndex(room, text, null) ?? 0),
});

export const addAgentReply = (
  room: Room,
  speakerIndex: number,
  reply: string,
  at: string,
): Room => {
  const speaker = room.participants[speakerIndex]!.label;
  // Agents often echo the transcript's "[Name]:" format back at the start of a reply.
  const text = reply.replace(new RegExp(`^\\s*[*[]*${escapeRegExp(speaker)}[\\]:*]+\\s*`, "i"), "");
  const transcript: ReadonlyArray<RoomMessage> = [...room.transcript, { speaker, text, at }];
  const turnsLeft = room.turnsLeft - 1;
  const done = turnsLeft <= 0;
  return {
    ...room,
    transcript,
    turnsLeft: Math.max(turnsLeft, 0),
    status: done ? "idle" : "running",
    speakerIndex: done ? null : nextSpeakerIndex(room, speakerIndex, text),
  };
};

const leadPreamble = (room: Room, label: string) => {
  const helpers = (room.helpers ?? [])
    .map(
      (helper) =>
        `${helper.label} (providerInstanceId "${helper.modelSelection.instanceId}", model "${helper.modelSelection.model}")`,
    )
    .join(", ");
  return `You are ${label}, the lead agent for "${room.title}". Do the judgment-heavy work yourself and hand independent pieces to your helpers with delegate_task, setting target to one of: ${helpers}. When their results arrive, combine them and report back to the user.`;
};

/** Builds the speaker's next prompt and records what it has now been sent. */
export const beginTurn = (room: Room, speakerIndex: number) => {
  const speaker = room.participants[speakerIndex]!;
  const others = room.participants
    .filter((_, index) => index !== speakerIndex)
    .map((participant) =>
      participant.role ? `${participant.label} (${participant.role})` : participant.label,
    );
  const unseen = room.transcript
    .slice(speaker.seen)
    .filter((message) => message.speaker !== speaker.label)
    .map((message) => `[${message.speaker}]: ${message.text}`);
  const prompt = [
    speaker.seen === 0 && room.mode === "lead" ? leadPreamble(room, speaker.label) : null,
    speaker.seen === 0 && room.mode !== "lead"
      ? `You are ${speaker.label} in a group chat titled "${room.title}" with the user and ${others.join(", ")}.${speaker.role ? ` Your role: ${speaker.role}.` : ""} Answer the discussion directly and briefly, disagree when you have a reason to, and write @Name to ask another participant something. Discuss only; do not change files unless the user asks.`
      : null,
    unseen.length > 0 ? unseen.join("\n\n") : "Please continue the discussion.",
    room.turnsLeft === 1 && room.mode !== "lead"
      ? 'This is the last turn. Summarize where the group landed in one line starting with "Decision:", and note any disagreement that remains.'
      : null,
  ]
    .filter((part) => part !== null)
    .join("\n\n");
  const updated: Room = {
    ...room,
    speakerIndex,
    participants: room.participants.map((participant, index) =>
      index === speakerIndex ? { ...participant, seen: room.transcript.length } : participant,
    ),
  };
  return { prompt, room: updated };
};
