/**
 * Analysis tools: local, offline heuristics applied to a unified diff.
 * They never call the network, which makes them cheap and deterministic.
 */
import { ok, type Tool, type ToolResult } from "../types/Tool.js";

export type Language = "typescript" | "javascript" | "python" | "go" | "java" | "unknown";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  rule: string;
  message: string;
}

export interface CodeQualityReport {
  language: Language;
  filesChanged: number;
  addedLines: number;
  removedLines: number;
  findings: Finding[];
  score: number;
}

export interface SecurityReport {
  language: Language;
  findings: Finding[];
  hasBlockingIssue: boolean;
}

export interface TestCoverageReport {
  changedSourceFiles: string[];
  changedTestFiles: string[];
  untestedFiles: string[];
  ratio: number;
}

export interface RiskAssessment {
  level: "low" | "medium" | "high";
  score: number;
  reasons: string[];
}

export interface ChangeSummary {
  filesChanged: number;
  addedLines: number;
  removedLines: number;
  touchesMigrations: boolean;
  touchesCiConfig: boolean;
  securityFindings: number;
  testRatio: number;
}

interface AddedLine {
  file: string;
  line: number;
  content: string;
}

const QUALITY_RULES: Array<{ rule: string; severity: Severity; message: string; pattern: RegExp }> = [
  { rule: "no-console", severity: "low", message: "Leftover console/debug statement.", pattern: /\bconsole\.(log|debug)\s*\(/ },
  { rule: "no-debugger", severity: "medium", message: "`debugger` statement committed.", pattern: /\bdebugger\b/ },
  { rule: "no-any", severity: "low", message: "Explicit `any` weakens type safety.", pattern: /:\s*any\b/ },
  { rule: "no-todo", severity: "info", message: "TODO/FIXME left in the diff.", pattern: /\b(TODO|FIXME)\b/ },
  { rule: "no-long-line", severity: "info", message: "Line longer than 160 characters.", pattern: /^.{161,}$/ },
  { rule: "no-empty-catch", severity: "medium", message: "Empty catch block swallows errors.", pattern: /catch\s*\([^)]*\)\s*\{\s*\}/ }
];

const SECURITY_RULES: Array<{ rule: string; severity: Severity; message: string; pattern: RegExp }> = [
  { rule: "hardcoded-secret", severity: "critical", message: "Possible hardcoded credential.", pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { rule: "dangerous-eval", severity: "high", message: "Dynamic code evaluation.", pattern: /\b(eval|new\s+Function)\s*\(/ },
  { rule: "child-process-shell", severity: "high", message: "Shell execution with interpolated input.", pattern: /exec(Sync)?\s*\(\s*[`'"][^`'"]*\$\{/ },
  { rule: "sql-injection", severity: "high", message: "SQL query built by string concatenation.", pattern: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\+\s*\w+/i },
  { rule: "insecure-random", severity: "medium", message: "Math.random() used where a CSPRNG may be required.", pattern: /Math\.random\s*\(/ },
  { rule: "disabled-tls", severity: "critical", message: "TLS verification disabled.", pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/ }
];

const TEST_FILE_PATTERN = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|Test\.java$/;

const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 1,
  low: 2,
  medium: 5,
  high: 10,
  critical: 20
};

/** Detects the dominant language of a diff from the file extensions it touches. */
export function detectLanguage(diff: string): Language {
  const counters: Record<Language, number> = {
    typescript: 0,
    javascript: 0,
    python: 0,
    go: 0,
    java: 0,
    unknown: 0
  };

  for (const file of listChangedFiles(diff)) {
    if (/\.[cm]?tsx?$/.test(file)) counters.typescript += 1;
    else if (/\.[cm]?jsx?$/.test(file)) counters.javascript += 1;
    else if (/\.py$/.test(file)) counters.python += 1;
    else if (/\.go$/.test(file)) counters.go += 1;
    else if (/\.java$/.test(file)) counters.java += 1;
    else counters.unknown += 1;
  }

  return (Object.entries(counters) as Array<[Language, number]>).reduce<[Language, number]>(
    (best, current) => (current[1] > best[1] ? current : best),
    ["unknown", 0]
  )[0];
}

/** Lists the files touched by a unified diff. */
export function listChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    if (match?.[1] && match[1] !== "/dev/null") {
      files.add(match[1]);
    }
  }
  return [...files];
}

/** Extracts added lines with their file and (approximate) line number. */
function listAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let currentFile = "unknown";
  let currentLine = 0;

  for (const rawLine of diff.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(rawLine);
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1];
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunkMatch?.[1]) {
      currentLine = Number(hunkMatch[1]);
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      added.push({ file: currentFile, line: currentLine, content: rawLine.slice(1) });
      currentLine += 1;
    } else if (!rawLine.startsWith("-") && !rawLine.startsWith("\\")) {
      currentLine += 1;
    }
  }

  return added;
}

function countRemovedLines(diff: string): number {
  return diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
}

function applyRules(
  addedLines: AddedLine[],
  rules: Array<{ rule: string; severity: Severity; message: string; pattern: RegExp }>
): Finding[] {
  const findings: Finding[] = [];
  for (const added of addedLines) {
    for (const rule of rules) {
      if (rule.pattern.test(added.content)) {
        findings.push({
          file: added.file,
          line: added.line,
          severity: rule.severity,
          rule: rule.rule,
          message: rule.message
        });
      }
    }
  }
  return findings;
}

/**
 * Scores the quality of a diff (100 = clean) using lightweight lexical rules.
 * TODO: complement these heuristics with a real AST based linter per language.
 */
export function analyzeCodeQuality(diff: string, language?: Language): ToolResult<CodeQualityReport> {
  const addedLines = listAddedLines(diff);
  const findings = applyRules(addedLines, QUALITY_RULES);
  const penalty = findings.reduce((total, finding) => total + SEVERITY_WEIGHT[finding.severity], 0);

  return ok({
    language: language ?? detectLanguage(diff),
    filesChanged: listChangedFiles(diff).length,
    addedLines: addedLines.length,
    removedLines: countRemovedLines(diff),
    findings,
    score: Math.max(0, 100 - penalty)
  });
}

/**
 * Flags common security anti-patterns introduced by the diff.
 * TODO: delegate to CodeQL / semgrep for deeper, language aware analysis.
 */
export function detectSecurityIssues(diff: string, language?: Language): ToolResult<SecurityReport> {
  const findings = applyRules(listAddedLines(diff), SECURITY_RULES);
  return ok({
    language: language ?? detectLanguage(diff),
    findings,
    hasBlockingIssue: findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
  });
}

/** Compares changed source files with changed test files to estimate coverage. */
export function analyzeTestCoverage(diff: string, testFiles: string[] = []): ToolResult<TestCoverageReport> {
  const changed = listChangedFiles(diff);
  const changedTestFiles = [...new Set([...changed.filter((file) => TEST_FILE_PATTERN.test(file)), ...testFiles])];
  const changedSourceFiles = changed.filter((file) => !TEST_FILE_PATTERN.test(file));

  const testedStems = new Set(
    changedTestFiles.map((file) => {
      const base = file.split("/").pop() ?? file;
      return base.replace(/\.(test|spec)\./, ".").replace(/_test\./, ".").replace(/\.[^.]+$/, "");
    })
  );

  const untestedFiles = changedSourceFiles.filter((file) => {
    const stem = (file.split("/").pop() ?? file).replace(/\.[^.]+$/, "");
    return !testedStems.has(stem);
  });

  const ratio =
    changedSourceFiles.length === 0
      ? 1
      : (changedSourceFiles.length - untestedFiles.length) / changedSourceFiles.length;

  return ok({ changedSourceFiles, changedTestFiles, untestedFiles, ratio: Number(ratio.toFixed(2)) });
}

/** Aggregates the signals above into a single risk level. */
export function assessRiskLevel(changes: ChangeSummary): ToolResult<RiskAssessment> {
  const reasons: string[] = [];
  let score = 0;

  if (changes.filesChanged > 30) {
    score += 25;
    reasons.push(`${changes.filesChanged} files changed: the PR is hard to review in one pass.`);
  }
  if (changes.addedLines + changes.removedLines > 1000) {
    score += 20;
    reasons.push("More than 1000 lines changed.");
  }
  if (changes.touchesMigrations) {
    score += 25;
    reasons.push("Database migrations are included: rollback needs a plan.");
  }
  if (changes.touchesCiConfig) {
    score += 10;
    reasons.push("CI or build configuration is modified.");
  }
  if (changes.securityFindings > 0) {
    score += 15 * Math.min(changes.securityFindings, 3);
    reasons.push(`${changes.securityFindings} security finding(s) reported.`);
  }
  if (changes.testRatio < 0.5) {
    score += 15;
    reasons.push("Less than half of the changed source files have accompanying tests.");
  }
  if (reasons.length === 0) {
    reasons.push("Small, focused and tested change.");
  }

  const level = score >= 60 ? "high" : score >= 25 ? "medium" : "low";
  return ok({ level, score: Math.min(score, 100), reasons });
}

/** Builds a `ChangeSummary` from a diff, ready to be fed to `assessRiskLevel`. */
export function summarizeChanges(diff: string): ChangeSummary {
  const files = listChangedFiles(diff);
  const quality = analyzeCodeQuality(diff).data;
  const security = detectSecurityIssues(diff).data;
  const coverage = analyzeTestCoverage(diff).data;

  return {
    filesChanged: files.length,
    addedLines: quality?.addedLines ?? 0,
    removedLines: quality?.removedLines ?? 0,
    touchesMigrations: files.some((file) => /migrations?\//i.test(file)),
    touchesCiConfig: files.some((file) => /^\.github\/workflows\/|Dockerfile|\.ya?ml$/.test(file)),
    securityFindings: security?.findings.length ?? 0,
    testRatio: coverage?.ratio ?? 0
  };
}

/** MCP-facing tool descriptors backed by the functions above. */
export const analysisTools: Array<Tool<Record<string, unknown>, unknown>> = [
  {
    name: "analyze_diff",
    description: "Score the quality of a unified diff and report lexical findings.",
    parameters: [
      { name: "diff", type: "string", required: true, description: "Unified diff to analyse." },
      { name: "language", type: "string", required: false, description: "Override the detected language." }
    ],
    execute: async (input) =>
      analyzeCodeQuality(String(input["diff"]), input["language"] as Language | undefined)
  },
  {
    name: "detect_security_issues",
    description: "Detect common security anti-patterns in a unified diff.",
    parameters: [
      { name: "diff", type: "string", required: true, description: "Unified diff to analyse." },
      { name: "language", type: "string", required: false, description: "Override the detected language." }
    ],
    execute: async (input) =>
      detectSecurityIssues(String(input["diff"]), input["language"] as Language | undefined)
  },
  {
    name: "analyze_test_coverage",
    description: "Estimate whether the changed source files come with tests.",
    parameters: [
      { name: "diff", type: "string", required: true, description: "Unified diff to analyse." },
      { name: "test_files", type: "array", required: false, description: "Extra test files to take into account." }
    ],
    execute: async (input) =>
      analyzeTestCoverage(String(input["diff"]), (input["test_files"] as string[] | undefined) ?? [])
  },
  {
    name: "assess_risk_level",
    description: "Aggregate change signals into a low/medium/high risk level.",
    parameters: [
      { name: "changes", type: "object", required: true, description: "Change summary produced by summarizeChanges." }
    ],
    execute: async (input) => assessRiskLevel(input["changes"] as ChangeSummary)
  }
];
