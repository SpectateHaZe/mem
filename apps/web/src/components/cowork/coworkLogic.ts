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

export function decisionLine(text: string): string | null {
  return DECISION_LINE.exec(text)?.[1]?.trim() ?? null;
}

/** The reply without its decision line, which the UI shows in its own callout. */
export function withoutDecision(text: string): string {
  return text.replace(DECISION_LINE, "").trim();
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
