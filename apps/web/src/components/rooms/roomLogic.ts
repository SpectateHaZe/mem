import type { GoalQueue, ModelSelection, ServerProvider } from "@t3tools/contracts";

export interface RoomModelOption {
  readonly key: string;
  /** Default name; must work as an @mention. */
  readonly label: string;
  readonly description: string;
  readonly modelSelection: ModelSelection;
}

const mentionName = (name: string) => name.trim().replace(/\s+/g, "-");

export function modelOptions(providers: ReadonlyArray<ServerProvider>): RoomModelOption[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.instanceId}::${model.slug}`,
        label: mentionName(model.shortName ?? model.name),
        description: `${provider.displayName ?? provider.driver} · ${model.name}${model.slug.endsWith("-free") ? " (free)" : ""}`,
        modelSelection: { instanceId: provider.instanceId, model: model.slug },
      })),
    );
}

export function validateNewRoom(input: {
  readonly title: string;
  readonly message: string;
  readonly rounds: number;
  readonly projectId: string;
  readonly agents: ReadonlyArray<{ readonly optionKey: string; readonly label: string }>;
}): string | null {
  if (input.title.trim() === "") return "Give the group chat a title.";
  if (input.projectId === "") return "Choose a project.";
  if (input.agents.some((agent) => agent.optionKey === "")) return "Choose a model for each agent.";
  const names = input.agents.map((agent) => agent.label.trim().toLowerCase());
  if (names.some((name) => name === "" || /\s/.test(name))) {
    return "Agent names can't be empty or contain spaces, since they're used for @mentions.";
  }
  if (new Set(names).size !== names.length) return "Give each agent a different name.";
  if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 20) {
    return "Rounds must be a whole number from 1 to 20.";
  }
  if (input.message.trim() === "") return "Write a first message.";
  return null;
}

const DECISION_LINE = /^[ \t]*\**Decision:\**[ \t]*(.+?)\**[ \t]*$/im;

export function decisionLine(text: string): string | null {
  return DECISION_LINE.exec(text)?.[1]?.trim() ?? null;
}

/** The reply without its decision line, which the page shows separately. */
export function withoutDecision(text: string): string {
  return text.replace(DECISION_LINE, "").trim();
}

export function speakerColor(speaker: string): string | undefined {
  if (speaker === "You") return undefined;
  let hash = 0;
  for (const char of speaker) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 65% 62%)`;
}

type QueueAlert = {
  readonly type: "success" | "error" | "warning";
  readonly title: string;
  readonly description: string;
};

/** What changed worth telling someone who walked away. The first snapshot is history, not news. */
export function queueAlerts(previous: GoalQueue | undefined, next: GoalQueue) {
  if (previous === undefined) return [];
  const before = new Map(previous.goals.map((goal) => [goal.id, goal.status]));
  const alerts: QueueAlert[] = next.goals.flatMap((goal): QueueAlert[] => {
    const was = before.get(goal.id);
    if (was === undefined || was === goal.status) return [];
    if (goal.status === "done") {
      return [{ type: "success", title: "Queue goal finished", description: goal.text }];
    }
    if (goal.status === "failed") {
      return [{ type: "error", title: "Queue goal failed", description: goal.text }];
    }
    return [];
  });
  if (next.note !== undefined && next.note !== previous.note && next.note !== "Paused.") {
    alerts.push({ type: "warning", title: "Queue stopped", description: next.note });
  }
  return alerts;
}
