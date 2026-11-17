import { DEFAULT_MEM_QUALITY_PROMPT } from "@t3tools/contracts";

/**
 * Cap on `{{evidence}}`, so a runaway reply cannot crowd out the rubric. `{{changes}}` is one review
 * batch, already capped by `MemReviewContext`; cutting it again hid most of every batch.
 */
export const QUALITY_GATE_SUBSTITUTION_LIMIT = 40_000;

export const QUALITY_GATE_TRUNCATION_MARKER = "\u2026[truncated]";

export interface QualityGatePromptInput {
  readonly template: string;
  readonly task: string;
  readonly acceptance: string;
  readonly changes: string;
  readonly evidence: string;
}

export type QualityGateVerdictValue = "accept" | "reject";

export interface QualityGateResult {
  readonly verdict: QualityGateVerdictValue;
  readonly findings: ReadonlyArray<string>;
  readonly reasoning: string;
  readonly nextInstruction: string | null;
  readonly usable: boolean;
}

const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;

const truncate = (value: string): string =>
  value.length <= QUALITY_GATE_SUBSTITUTION_LIMIT
    ? value
    : `${value.slice(0, QUALITY_GATE_SUBSTITUTION_LIMIT)}${QUALITY_GATE_TRUNCATION_MARKER}`;

const MARKER_PREFIX = /^[#>\s]*(?:\*{1,2}|_{1,2}|`)*\s*/;

const VERDICT_HEADING = /^verdict(?![a-z0-9])/i;

// A heading has a colon or the line to itself, so "Findings above also apply..." stays content.
const SECTION_HEADING =
  /^(findings|reasoning|next instruction)(?![a-z0-9])\s*\*{0,2}\s*(?::\s*\*{0,2}\s*(.*)|\s*)$/i;

const CODE_FENCE = /^\s*```/;

const BULLET_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;

const stripMarkerPrefix = (line: string): string => line.replace(MARKER_PREFIX, "");

const normalizeHeading = (heading: string): "findings" | "reasoning" | "nextInstruction" => {
  const lower = heading.trim().toLowerCase();
  if (lower.startsWith("next")) return "nextInstruction";
  return lower === "findings" ? "findings" : "reasoning";
};

export const buildQualityGatePrompt = (input: QualityGatePromptInput): string => {
  const template = input.template.trim().length === 0 ? DEFAULT_MEM_QUALITY_PROMPT : input.template;
  const substitutions: Record<string, string> = {
    task: input.task,
    acceptance: input.acceptance,
    changes: input.changes,
    evidence: truncate(input.evidence),
  };
  // One pass, so substituted text is never rescanned for placeholders it happens to contain.
  return template.replace(
    PLACEHOLDER_PATTERN,
    (match, name: string) => substitutions[name] ?? match,
  );
};

const collectSections = (
  lines: ReadonlyArray<string>,
  startIndex: number,
): Map<string, string[]> => {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (CODE_FENCE.test(line)) continue;
    const heading = SECTION_HEADING.exec(stripMarkerPrefix(line));
    if (heading) {
      current = [];
      sections.set(normalizeHeading(heading[1] ?? ""), current);
      const inline = (heading[2] ?? "").trim();
      if (inline.length > 0) current.push(inline);
      continue;
    }
    current?.push(line);
  }
  return sections;
};

const stripBullet = (line: string): string => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");

const sectionText = (lines: ReadonlyArray<string> | undefined): string =>
  (lines ?? [])
    .map((line) => stripBullet(line).trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();

const sectionFindings = (lines: ReadonlyArray<string> | undefined): string[] => {
  const items: string[] = [];
  for (const line of lines ?? []) {
    const bullet = BULLET_ITEM.exec(line);
    const item = bullet?.[1]?.trim();
    if (item && !/^none[.!]?$/i.test(item)) items.push(item);
  }
  return items;
};

/** `ACCEPT` or `REJECT` as the value's first word; "Do not accept" or "ACCEPT or REJECT" is neither. */
const verdictToken = (rest: string): QualityGateVerdictValue | null => {
  const token = /^(accept|reject)\b/i.exec(rest)?.[1]?.toLowerCase();
  if (token !== "accept" && token !== "reject") return null;
  const other = token === "accept" ? /\breject\b/i : /\baccept\b/i;
  return other.test(rest) ? null : token;
};

/**
 * Reads the reviewer's reply. Only a `VERDICT:` line is trusted, and it fails closed: a verdict
 * quoted inside `{{changes}}` or `{{evidence}}`, before or after the reviewer's own, can turn an
 * accept into a reject but never a reject into an accept. Never throws.
 */
export const parseQualityGateVerdict = (raw: string): QualityGateResult => {
  const lines = raw.split(/\r?\n/);
  let verdictIndex = -1;
  let verdict: QualityGateVerdictValue | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripMarkerPrefix(lines[index] ?? "");
    if (!VERDICT_HEADING.test(stripped)) continue;
    const rest = stripped.replace(/^verdict/i, "").replace(/^[\s*:`]+/, "");
    const token = verdictToken(rest);
    if (verdictIndex === -1) verdictIndex = index;
    if (token === null) continue;
    // Sections follow the line that decided the verdict; a later accept never replaces a reject.
    if (verdict !== "reject" || token === "reject") {
      verdict = token;
      verdictIndex = index;
    }
  }

  if (verdictIndex === -1) {
    return {
      verdict: "reject",
      findings: [],
      reasoning: "",
      nextInstruction: null,
      usable: false,
    };
  }

  const sections = collectSections(lines, verdictIndex + 1);
  const nextInstruction = sectionText(sections.get("nextInstruction"));

  return {
    verdict: verdict ?? "reject",
    findings: sectionFindings(sections.get("findings")),
    reasoning: sectionText(sections.get("reasoning")),
    nextInstruction: nextInstruction.length === 0 ? null : nextInstruction,
    usable: verdict !== null,
  };
};

/** Fail closed: an unusable review is rework, never acceptance. */
export const requiresRework = (result: QualityGateResult): boolean =>
  !result.usable || result.verdict === "reject";
