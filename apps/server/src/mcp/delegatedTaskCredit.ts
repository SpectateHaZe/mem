const CREDIT_EXHAUSTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\binsufficient (?:account |user |card )?(?:balance|credits?|funds?|quota)\b/i,
  /\binsufficient_\w*quota/i,
  /\bout of credits?\b/i,
  /\bno remaining credits?\b/i,
  /\bcredit limit\b/i,
  /\b(?:credit|account) balance (?:is )?(?:too low|empty|zero)\b/i,
  /\bquota (?:has been |is )?(?:exhausted|exceeded)\b/i,
  /\bexceeded (?:your |the )?(?:current )?quota\b/i,
  /\breached (?:your |the |a )?(?:[\w-]+ )*quota\b/i,
  /\bresource[ _]?exhausted\b/i,
  /\bbilling (?:information|details|method|address|status|issue|problem|error|account|section)\b/i,
  /\bpayment required\b/i,
];

/** True only for an account out of credit. A rate limit, a bad request, or a cancel is not one. */
export function isCreditExhaustionFailure(message: string): boolean {
  return CREDIT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The note a credit-fallback retry carries in its prompt. Its opening sentence
 * also marks a retry in an existing task's prompt, so a retry whose fallback
 * model runs out of credit too does not start a second fallback.
 */
export function creditFallbackRetryNote(failed: {
  readonly providerInstanceId: string;
  readonly model: string | null;
}): string {
  return `The previous attempt on ${failed.providerInstanceId} (${failed.model}) ran out of credit before it finished. It may have left uncommitted changes. Inspect the existing uncommitted changes (for example with git status and git diff) and continue from them instead of starting over.`;
}

export function isCreditFallbackRetryPrompt(prompt: string): boolean {
  return /\nThe previous attempt on .+ \(.+\) ran out of credit before it finished\.?/.test(prompt);
}
