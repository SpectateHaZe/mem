import type { CoworkSession, ModelSelection, ServerProvider } from "@t3tools/contracts";

export interface CoworkModelOption {
  readonly key: string;
  /** Default name; must work as an @mention. */
  readonly label: string;
  readonly description: string;
  readonly providerInstanceId: string;
  readonly modelSelection: ModelSelection;
}

const mentionName = (name: string) => name.trim().replace(/\s+/g, "-");

export function modelOptions(providers: ReadonlyArray<ServerProvider>): CoworkModelOption[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.instanceId}::${model.slug}`,
        label: mentionName(model.shortName ?? model.name),
        description: `${provider.displayName ?? provider.driver} · ${model.name}${model.slug.endsWith("-free") ? " (free)" : ""}`,
        providerInstanceId: provider.instanceId,
        modelSelection: { instanceId: provider.instanceId, model: model.slug },
      })),
    );
}

export const modelOptionKey = (selection: ModelSelection) =>
  `${selection.instanceId}::${selection.model}`;

export interface CoworkPeerDraft {
  readonly key: number;
  readonly label: string;
  readonly modelSelection: ModelSelection;
}

/** A mention-safe name for the model, suffixed until no other peer uses it. */
export function coworkPeerLabel(
  selection: ModelSelection,
  options: ReadonlyArray<CoworkModelOption>,
  taken: ReadonlyArray<string>,
): string {
  const base =
    options.find((option) => option.key === modelOptionKey(selection))?.label ??
    mentionName(selection.model);
  const used = new Set(taken.map((label) => label.toLowerCase()));
  let label = base;
  for (let suffix = 2; used.has(label.toLowerCase()); suffix += 1) label = `${base}-${suffix}`;
  return label;
}

/** Peers all start on the session's own model so they think like the session does. */
export function addCoworkPeer(
  peers: ReadonlyArray<CoworkPeerDraft>,
  selection: ModelSelection,
  options: ReadonlyArray<CoworkModelOption>,
): ReadonlyArray<CoworkPeerDraft> {
  const key = Math.max(-1, ...peers.map((peer) => peer.key)) + 1;
  const label = coworkPeerLabel(
    selection,
    options,
    peers.map((peer) => peer.label),
  );
  return [...peers, { key, label, modelSelection: selection }];
}

export function validateCoworkSetup(input: {
  readonly message: string;
  readonly rounds: number;
  readonly agents: ReadonlyArray<{ readonly label: string }>;
}): string | null {
  if (input.agents.length < 2) return "Add at least 2 peers.";
  const names = input.agents.map((agent) => agent.label.trim().toLowerCase());
  if (names.some((name) => name === "" || /\s/.test(name))) {
    return "Peer names can't be empty or contain spaces.";
  }
  if (new Set(names).size !== names.length) return "Give each peer a different name.";
  if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 10) {
    return "Rounds must be a whole number from 1 to 10.";
  }
  if (input.message.trim() === "") return "Write a topic for the peers.";
  return null;
}

const DECISION_LINE = /^[ \t]*\**Decision:\**[ \t]*(.+?)\**[ \t]*$/im;
const USER_SUMMARY_LINE = /^[ \t]*(?:[-*][ \t]+)?\**(?:For you|Summary):\**[ \t]*(.+?)\**[ \t]*$/im;
const STANCE_LINE = /^[ \t]*\**Stance:.*$/gim;
const MAX_FALLBACK_SUMMARY_CHARS = 180;

const withoutDecisionOrStance = (text: string) =>
  text.replace(DECISION_LINE, "").replace(STANCE_LINE, "").trim();

function condenseForUser(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ");
  const lines = withoutCode
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const nonHeadingLines = lines.filter((line) => !/^#{1,6}[ \t]+/.test(line));
  const chosenLines = nonHeadingLines.length > 0 ? nonHeadingLines : lines;
  const plainLines = chosenLines.map((line) =>
    line
      .replace(/^(?:#{1,6}|[-*+]|\d+\.|>)[ \t]+/, "")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .trim(),
  );
  const normalized = plainLines.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (normalized === "") return "";
  const firstSentence = /^(.{25,}?[.!?])(?:\s|$)/.exec(normalized)?.[1];
  if (
    firstSentence &&
    firstSentence.length <= MAX_FALLBACK_SUMMARY_CHARS &&
    normalized.length > 100
  ) {
    return firstSentence;
  }
  if (normalized.length <= MAX_FALLBACK_SUMMARY_CHARS) return normalized;
  const clipped = normalized.slice(0, MAX_FALLBACK_SUMMARY_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 80 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

/** Returns a short user-facing summary for a cowork turn without walls of peer text. */
export function coworkTurnSummary(
  message: Pick<CoworkSession["transcript"][number], "kind" | "text" | "summary">,
): string {
  if (message.kind === "user") return message.text.trim();
  if (message.summary && message.summary.trim() !== "") return message.summary.trim();
  const explicit = USER_SUMMARY_LINE.exec(message.text)?.[1]?.trim();
  if (explicit) return explicit;
  return condenseForUser(withoutDecisionOrStance(message.text));
}

export function coworkPhaseLabel(session: CoworkSession): string {
  switch (session.phase) {
    case "thinking": {
      const doneCount = session.participants.filter((p) => p.status === "done").length;
      return `Thinking (${doneCount}/${session.participants.length})`;
    }
    case "deliberating":
      return session.mode === "code"
        ? `Building ${session.currentRound}/${session.maxRounds}`
        : `Round ${session.currentRound}/${session.maxRounds}`;
    case "decided":
      return "Decided";
    case "paused":
      return "Paused";
  }
}

export function coworkDecisionSummary(session: CoworkSession): string | null {
  if (session.decision && session.decision.trim() !== "") return session.decision.trim();
  if (session.phase !== "decided") return null;
  for (let i = session.transcript.length - 1; i >= 0; i -= 1) {
    const entry = session.transcript[i]!;
    if (entry.kind !== "user" && entry.text.trim() !== "") {
      return entry.text.trim();
    }
  }
  return null;
}
