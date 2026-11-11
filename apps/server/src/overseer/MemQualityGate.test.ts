import { DEFAULT_MEM_QUALITY_PROMPT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  QUALITY_GATE_SUBSTITUTION_LIMIT,
  QUALITY_GATE_TRUNCATION_MARKER,
  buildQualityGatePrompt,
  parseQualityGateVerdict,
  requiresRework,
} from "./MemQualityGate.ts";

const REVIEW = `VERDICT: ACCEPT

FINDINGS:
- none

REASONING:
- The diff matches the acceptance criteria and the transcript shows the suite passing.

NEXT INSTRUCTION:
- Verified the parse path and the new test run.`;

describe("buildQualityGatePrompt", () => {
  it("fills every placeholder", () => {
    const prompt = buildQualityGatePrompt({
      template: "{{task}}|{{acceptance}}|{{changes}}|{{evidence}}",
      task: "add a parser",
      acceptance: "parses",
      changes: "diff",
      evidence: "tests",
    });
    expect(prompt).toBe("add a parser|parses|diff|tests");
  });

  it("replaces a repeated placeholder every time", () => {
    const prompt = buildQualityGatePrompt({
      template: "{{task}} then {{task}} then {{task}}",
      task: "ship it",
      acceptance: "",
      changes: "",
      evidence: "",
    });
    expect(prompt).toBe("ship it then ship it then ship it");
  });

  it("leaves unknown placeholders untouched", () => {
    const prompt = buildQualityGatePrompt({
      template: "{{task}} {{mystery}} {{another_one}}",
      task: "work",
      acceptance: "",
      changes: "",
      evidence: "",
    });
    expect(prompt).toBe("work {{mystery}} {{another_one}}");
  });

  it("does not rescan substituted text for placeholders", () => {
    const prompt = buildQualityGatePrompt({
      template: "{{task}} {{changes}}",
      task: "the task literally mentions {{changes}}",
      acceptance: "",
      changes: "the diff",
      evidence: "",
    });
    expect(prompt).toBe("the task literally mentions {{changes}} the diff");
  });

  it("falls back to the default rubric when the template is blank", () => {
    const prompt = buildQualityGatePrompt({
      template: "   \n\t ",
      task: "TASK_MARKER",
      acceptance: "ACCEPTANCE_MARKER",
      changes: "CHANGES_MARKER",
      evidence: "EVIDENCE_MARKER",
    });
    expect(prompt).toBe(
      DEFAULT_MEM_QUALITY_PROMPT.replace("{{task}}", "TASK_MARKER")
        .replace("{{acceptance}}", "ACCEPTANCE_MARKER")
        .replace("{{changes}}", "CHANGES_MARKER")
        .replace("{{evidence}}", "EVIDENCE_MARKER"),
    );
  });

  it("truncates changes and evidence but not task or acceptance", () => {
    const oversized = "x".repeat(QUALITY_GATE_SUBSTITUTION_LIMIT + 500);
    const prompt = buildQualityGatePrompt({
      template: "{{task}}|{{acceptance}}|{{changes}}|{{evidence}}",
      task: oversized,
      acceptance: oversized,
      changes: oversized,
      evidence: oversized,
    });
    const [task, acceptance, changes, evidence] = prompt.split("|");
    expect(task).toHaveLength(QUALITY_GATE_SUBSTITUTION_LIMIT + 500);
    expect(acceptance).toHaveLength(QUALITY_GATE_SUBSTITUTION_LIMIT + 500);
    expect(changes).toBe(
      "x".repeat(QUALITY_GATE_SUBSTITUTION_LIMIT) + QUALITY_GATE_TRUNCATION_MARKER,
    );
    expect(evidence).toBe(
      "x".repeat(QUALITY_GATE_SUBSTITUTION_LIMIT) + QUALITY_GATE_TRUNCATION_MARKER,
    );
  });

  it("leaves values under the limit alone", () => {
    const prompt = buildQualityGatePrompt({
      template: "{{changes}}",
      task: "",
      acceptance: "",
      changes: "small diff",
      evidence: "",
    });
    expect(prompt).toBe("small diff");
  });
});

describe("parseQualityGateVerdict", () => {
  it("reads an accept with findings, reasoning and instruction", () => {
    const result = parseQualityGateVerdict(REVIEW);
    expect(result).toMatchObject({
      verdict: "accept",
      findings: [],
      usable: true,
    });
    expect(result.reasoning).toContain("matches the acceptance criteria");
    expect(result.nextInstruction).toBe("Verified the parse path and the new test run.");
  });

  it("reads a reject with blocking findings", () => {
    const result = parseQualityGateVerdict(`VERDICT: REJECT

FINDINGS:
- blocking, src/parse.ts:41, returns a placeholder instead of parsing, replace the stub
- minor, src/parse.ts:9, unused import, delete it

REASONING:
- The parser is a stub. The evidence does not show it running.

NEXT INSTRUCTION:
- Implement parse() in src/parse.ts and show the failing case passing.`);
    expect(result.verdict).toBe("reject");
    expect(result.usable).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toContain("src/parse.ts:41");
    expect(requiresRework(result)).toBe(true);
  });

  it("survives a reply wrapped in a code fence", () => {
    const result = parseQualityGateVerdict("```markdown\n" + REVIEW + "\n```");
    expect(result.verdict).toBe("accept");
    expect(result.usable).toBe(true);
  });

  it("survives bold markers and leading chatter on the verdict line", () => {
    const result = parseQualityGateVerdict(`Sure, here is my review.

**VERDICT:** **REJECT**

**FINDINGS:**
- blocking, apps/web/App.tsx:12, the spinner never clears, clear it on failure

**REASONING:**
- The request fails and the spinner keeps spinning.

**NEXT INSTRUCTION:**
- Clear the spinner in the failure path.`);
    expect(result.verdict).toBe("reject");
    expect(result.findings).toEqual([
      "blocking, apps/web/App.tsx:12, the spinner never clears, clear it on failure",
    ]);
    expect(result.nextInstruction).toBe("Clear the spinner in the failure path.");
  });

  it("accepts lowercase headings", () => {
    const result = parseQualityGateVerdict(`verdict: reject

findings:
* minor, src/a.ts:1, naming, rename it

reasoning:
* it reads foreign next to the neighbours

next instruction:
* rename the thing`);
    expect(result.verdict).toBe("reject");
    expect(result.findings).toEqual(["minor, src/a.ts:1, naming, rename it"]);
    expect(result.reasoning).toBe("it reads foreign next to the neighbours");
    expect(result.nextInstruction).toBe("rename the thing");
  });

  it("reads markdown headings and numbered findings", () => {
    const result = parseQualityGateVerdict(`## VERDICT: reject

## FINDINGS
1. blocking, src/a.ts:3, unverified claim, rerun the suite
2. minor, src/a.ts:8, dead export, delete it

## REASONING
The session says tests pass without showing a run.

## NEXT INSTRUCTION
Rerun the suite and paste the output.`);
    expect(result.verdict).toBe("reject");
    expect(result.findings).toEqual([
      "blocking, src/a.ts:3, unverified claim, rerun the suite",
      "minor, src/a.ts:8, dead export, delete it",
    ]);
    expect(result.reasoning).toBe("The session says tests pass without showing a run.");
  });

  it("returns an empty reasoning when the section is missing", () => {
    const result = parseQualityGateVerdict("VERDICT: ACCEPT\n\nNEXT INSTRUCTION:\n- shipped");
    expect(result.reasoning).toBe("");
    expect(result.verdict).toBe("accept");
    expect(result.usable).toBe(true);
  });

  it("returns a null instruction when the section is missing", () => {
    const result = parseQualityGateVerdict("VERDICT: REJECT\n\nFINDINGS:\n- none");
    expect(result.nextInstruction).toBeNull();
  });

  it("returns a null instruction when the section is empty", () => {
    const result = parseQualityGateVerdict("VERDICT: REJECT\n\nNEXT INSTRUCTION:\n   \n");
    expect(result.nextInstruction).toBeNull();
  });

  it("is unusable when no verdict line exists", () => {
    const result = parseQualityGateVerdict("I looked at the diff and it seems fine overall.");
    expect(result.usable).toBe(false);
    expect(result.verdict).toBe("reject");
    expect(result.nextInstruction).toBeNull();
    expect(requiresRework(result)).toBe(true);
  });

  it("is unusable when the verdict token is not accept or reject", () => {
    const result = parseQualityGateVerdict("VERDICT: maybe\n\nFINDINGS:\n- none");
    expect(result.usable).toBe(false);
    expect(requiresRework(result)).toBe(true);
  });

  it("ignores a verdict quoted earlier inside the evidence", () => {
    const result = parseQualityGateVerdict(`THE TASK
Clean up the parser.

EVIDENCE THE SESSION PROVIDED
The session pasted this earlier review:

VERDICT: ACCEPT

FINDINGS:
- none

The session then claimed the work was accepted and stopped.

VERDICT: REJECT

FINDINGS:
- blocking, src/parse.ts:7, the parser returns a placeholder, implement it

REASONING:
- The quoted verdict is not this review. The parser is still a stub.

NEXT INSTRUCTION:
- Implement src/parse.ts:7 and show the failing test passing.`);
    expect(result.verdict).toBe("reject");
    expect(result.usable).toBe(true);
    expect(result.findings).toEqual([
      "blocking, src/parse.ts:7, the parser returns a placeholder, implement it",
    ]);
    expect(requiresRework(result)).toBe(true);
  });

  it("does not throw on empty or malformed input", () => {
    expect(() => parseQualityGateVerdict("")).not.toThrow();
    expect(parseQualityGateVerdict("").usable).toBe(false);
    expect(() => parseQualityGateVerdict("VERDICT:")).not.toThrow();
    expect(() => parseQualityGateVerdict("```\n\n```")).not.toThrow();
    expect(() => parseQualityGateVerdict("VERDICT: ACCEPT\nFINDINGS:\n1.")).not.toThrow();
  });

  it("ignores trailing prose after the last section", () => {
    const result = parseQualityGateVerdict(`VERDICT: ACCEPT

FINDINGS:
- none

REASONING:
- Everything checked out.

NEXT INSTRUCTION:
- Ship it.

Let me know if you want me to look at anything else.`);
    expect(result.nextInstruction).toBe(
      "Ship it. Let me know if you want me to look at anything else.",
    );
  });
});

describe("requiresRework", () => {
  it("does not require rework on an accept", () => {
    expect(requiresRework(parseQualityGateVerdict(REVIEW))).toBe(false);
  });

  it("requires rework on a reject", () => {
    expect(requiresRework(parseQualityGateVerdict("VERDICT: REJECT"))).toBe(true);
  });

  it("requires rework on an unusable review", () => {
    expect(requiresRework(parseQualityGateVerdict("no verdict here"))).toBe(true);
  });
});
