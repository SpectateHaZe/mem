import { DEFAULT_MEM_QUALITY_PROMPT } from "@t3tools/contracts";

/** Per-field cap on `{{changes}}` and `{{evidence}}`, so a runaway diff cannot crowd out the rubric. */
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

const SECTION_HEADING =
  /^(findings|reasoning|next instruction)(?![a-z0-9])\s*\*{0,2}\s*:?\s*\*{0,2}\s*(.*)$/i;

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
    changes: truncate(input.changes),
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

/**
 * Reads the reviewer's reply. Only a `VERDICT:` line is trusted, and the last one wins so a verdict
 * quoted inside `{{changes}}` or `{{evidence}}` cannot override the reviewer's own. Never throws.
 */
export const parseQualityGateVerdict = (raw: string): QualityGateResult => {
  const lines = raw.split(/\r?\n/);
  let verdictIndex = -1;
  let verdict: QualityGateVerdictValue | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripMarkerPrefix(lines[index] ?? "");
    if (!VERDICT_HEADING.test(stripped)) continue;
    verdictIndex = index;
    const rest = stripped.replace(/^verdict/i, "").replace(/^[\s*:`]+/, "");
    const token = /\b(accept|reject)\b/i.exec(rest)?.[1]?.toLowerCase();
    verdict = token === "accept" ? "accept" : token === "reject" ? "reject" : null;
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
