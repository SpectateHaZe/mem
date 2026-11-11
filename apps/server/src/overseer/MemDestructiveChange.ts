/**
 * The one thing Mem will not send without a human: an instruction that deletes a lot of the
 * owner's work. A prompt injection inside the code the session is reading is the threat, so the
 * question is "could this remove files?" and the answer errs toward yes.
 */

export interface MemDestructiveSignals {
  readonly instruction: string;
  readonly evidence: string;
  /** Measured by the review context; absent when this tick had no fresh review to measure. */
  readonly deletedLines?: number;
  readonly deletedFiles?: ReadonlyArray<string>;
}

/** Past these measured totals the change set is a large deletion, whatever the instruction says. */
const MEM_DELETION_MIN_DELETED_LINES = 200;
const MEM_DELETION_MIN_DELETED_FILES = 3;

/** One shell, PowerShell, SQL, or prose phrasing that removes work instead of changing it. */
const DELETION_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+\S/i,
  /\brmdir\b/i,
  /\bdel\s+[/\w]/i,
  /\berase\s+\S/i,
  /\bremove-item\b/i,
  /\bunlink\b/i,
  /\bgit\s+branch\s+(-D|--delete)\b/i,
  /\bgit\s+push\b[^\n]*--delete\b/i,
  /\bgit\s+clean\s+-[a-z]*[fdx]/i,
  /\bdrop\s+(table|database|schema|index|column)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\b(delete|remove|erase|wipe|purge|nuke|empty|clear|truncate|destroy)\b[^\n]{0,40}\b(files?|folders?|director(?:y|ies)|repos?(?:itory|itories)?|branches?|tables?|databases?|everything|all)\b/i,
  /\b(delet|remov|eras|wip|purg|nuk|empti|truncat|destroy|dropp)\w*\b[^\n]{0,40}\b(files?|folders?|director(?:y|ies)|repos?(?:itory|itories)?|branches?|tables?|databases?|everything|all)\b/i,
  /\b(delete|remove|wipe|purge)\s+(the\s+)?(entire|whole)\b/i,
];

export const isDestructiveDeletion = (signals: MemDestructiveSignals): boolean => {
  const text = `${signals.instruction}\n${signals.evidence}`;
  if (DELETION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // The measured numbers are the primary signal; the text above is the second opinion.
  return (
    (signals.deletedLines ?? 0) >= MEM_DELETION_MIN_DELETED_LINES ||
    (signals.deletedFiles?.length ?? 0) >= MEM_DELETION_MIN_DELETED_FILES
  );
};
