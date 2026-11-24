import type { OrchestrationV2Run } from "@t3tools/contracts";

const MAX_SUBAGENT_RESULT_CHARS = 20_000;

export const subagentStartedNote = (label: string, task: string) =>
  `I started a subagent (${label}) on this task. It works separately and its result will be sent here when it finishes, so don't start the same work.\n\nTask: ${task}`;

export const subagentFinishedNote = (
  label: string,
  status: OrchestrationV2Run["status"],
  result: string,
) => {
  const text = result.trim();
  const shown =
    text.length > MAX_SUBAGENT_RESULT_CHARS
      ? `${text.slice(0, MAX_SUBAGENT_RESULT_CHARS)}\n\n(Result cut off; the rest is in the subagent's side chat.)`
      : text;
  const heading =
    status === "completed"
      ? `Subagent (${label}) finished.`
      : `Subagent (${label}) stopped early (${status}).`;
  return shown ? `${heading}\n\n${shown}` : `${heading} It left no reply.`;
};
