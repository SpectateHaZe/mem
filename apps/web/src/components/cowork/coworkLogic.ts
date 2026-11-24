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

/** Picks two default equal peers, preferring distinct providers when available. */
export function defaultCoworkAgents(options: ReadonlyArray<CoworkModelOption>) {
  const first = options[0];
  const distinctProvider = options.find(
    (option) => first !== undefined && option.providerInstanceId !== first.providerInstanceId,
  );
  const second = distinctProvider ?? options[1] ?? first;
  const firstLabel = first?.label ?? "";
  const secondLabel =
    second === undefined
      ? ""
      : second.label.toLowerCase() === firstLabel.toLowerCase()
        ? `${second.label}-2`
        : second.label;
  return [
    { key: 0, optionKey: first?.key ?? "", label: firstLabel, role: "" },
    { key: 1, optionKey: second?.key ?? "", label: secondLabel, role: "Skeptic" },
  ];
}

export function validateCoworkSetup(input: {
  readonly message: string;
  readonly rounds: number;
  readonly agents: ReadonlyArray<{ readonly optionKey: string; readonly label: string }>;
}): string | null {
  if (input.agents.length < 2) return "Add at least 2 agents to cowork together.";
  if (input.agents.some((agent) => agent.optionKey === "")) return "Choose a model for each agent.";
  const names = input.agents.map((agent) => agent.label.trim().toLowerCase());
  if (names.some((name) => name === "" || /\s/.test(name))) {
    return "Agent names can't be empty or contain spaces, since they're used for @mentions.";
  }
  if (new Set(names).size !== names.length) return "Give each agent a different name.";
  if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 10) {
    return "Rounds must be a whole number from 1 to 10.";
  }
  if (input.message.trim() === "") return "Write a topic or goal for the agents.";
  return null;
}

const DECISION_LINE = /^[ \t]*\**Decision:\**[ \t]*(.+?)\**[ \t]*$/im;
const USER_SUMMARY_LINE = /^[ \t]*(?:[-*][ \t]+)?\**(?:For you|Summary):\**[ \t]*(.+?)\**[ \t]*$/im;
const MAX_FALLBACK_SUMMARY_CHARS = 180;

export function decisionLine(text: string): string | null {
  return DECISION_LINE.exec(text)?.[1]?.trim() ?? null;
}

/** The reply without its decision line, which the UI shows in its own callout. */
export function withoutDecision(text: string): string {
  return text.replace(DECISION_LINE, "").trim();
}

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
  return condenseForUser(withoutDecision(message.text));
}

export function coworkTurnDetails(
  message: Pick<CoworkSession["transcript"][number], "kind" | "text">,
): string {
  if (message.kind === "user") return message.text.trim();
  return withoutDecision(message.text).replace(USER_SUMMARY_LINE, "").trim();
}

export function coworkHasExtraDetails(
  message: Pick<CoworkSession["transcript"][number], "kind" | "text" | "summary">,
): boolean {
  if (message.kind === "user") return false;
  const details = coworkTurnDetails(message);
  if (details === "") return false;
  const summary = coworkTurnSummary(message);
  return details.replace(/\s+/g, " ").trim() !== summary.replace(/\s+/g, " ").trim();
}

export function speakerColor(speaker: string): string | undefined {
  if (speaker === "You") return undefined;
  let hash = 0;
  for (const char of speaker) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 65% 62%)`;
}

export function coworkPhaseLabel(session: CoworkSession): string {
  switch (session.phase) {
    case "thinking": {
      const doneCount = session.participants.filter((p) => p.status === "done").length;
      return `Thinking (${doneCount}/${session.participants.length})`;
    }
    case "deliberating":
      return `Round ${session.currentRound}/${session.maxRounds}`;
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
