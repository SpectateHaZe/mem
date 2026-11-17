/**
 * Remembers which ended runs were already acted on. The orchestrator re-sends a finished parent
 * run, still "completed", each time one of its subagents finishes; acting again would record an
 * old reply as a new one. Bounded, so a long-running server does not keep every run id.
 */
export const makeEndedRunTracker = (limit = 1_000) => {
  const seen = new Set<string>();
  /** True the first time a run id is offered, false for every repeat. */
  return (runId: string): boolean => {
    if (seen.has(runId)) return false;
    seen.add(runId);
    if (seen.size > limit) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
};
