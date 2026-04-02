import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MINIMAL_PATTERNS = [
  /\bwhat(?:'s| is) the time\b/i,
  /\bwhat time is it\b/i,
  /\bcurrent time\b/i,
  /\bwhat day is it\b/i,
  /\bdate\b/i,
  /\bpwd\b/i,
  /\bgit status\b/i,
  /\bshow (?:me )?(?:the )?version\b/i
];

const SIMPLE_PATTERNS = [
  /\btypo\b/i,
  /\brename\b/i,
  /\breword\b/i,
  /\brewrite\b/i,
  /\bformat\b/i,
  /\btranslate\b/i,
  /\bsummarize\b/i,
  /\bquick\b/i,
  /\bone[- ]liner\b/i,
  /\bsingle file\b/i,
  /\bexplain this\b/i
];

const STATUS_PREFIX_PATTERNS = [
  /^(?:did|do|does|have|has)\s+(?:you|we|it|the)\b/i,
  /^(?:is|are|was|were)\s+(?:it|this|that|the)\b/i,
  /^(?:can|could|will|would)\s+you\s+(?:confirm|check)\b/i
];

const STATUS_ACTION_PATTERNS = [
  /\bupdate(?:d)?\b/i,
  /\bchange(?:d)?\b/i,
  /\bfix(?:ed)?\b/i,
  /\badd(?:ed)?\b/i,
  /\bfinish(?:ed)?\b/i,
  /\bpush(?:ed)?\b/i,
  /\bmerge(?:d)?\b/i,
  /\breview(?:ed)?\b/i,
  /\b(?:write|wrote)\b/i,
  /\bdocument(?:ed)?\b/i,
  /\bship(?:ped)?\b/i
];

const FEATURE_GROUPS = [
  {
    label: "high-impact",
    weight: 6,
    patterns: [
      /\bprod(?:uction)?\b/i,
      /\blive\b/i,
      /\bpayment\b/i,
      /\bbilling\b/i,
      /\bmigration(?:s)?\b/i,
      /\bsecurity\b/i,
      /\bauth\b/i,
      /\bpermission(?:s)?\b/i,
      /\bsecret(?:s)?\b/i,
      /\bdelete\b/i,
      /\birreversible\b/i,
      /\bdata loss\b/i
    ]
  },
  {
    label: "research",
    weight: 4,
    patterns: [
      /\blatest\b/i,
      /\bbrowse\b/i,
      /\bresearch\b/i,
      /\bcitation(?:s)?\b/i,
      /\bcompare\b/i,
      /\bbenchmark\b/i,
      /\blook (?:it|this) up\b/i
    ]
  },
  {
    label: "verification-heavy",
    weight: 2,
    patterns: [
      /\bverify\b/i,
      /\bvalidate\b/i,
      /\bdouble-check\b/i,
      /\bprove\b/i
    ]
  },
  {
    label: "architecture",
    weight: 5,
    patterns: [
      /\bdesign\b/i,
      /\barchitecture\b/i,
      /\bstrategy\b/i,
      /\bsystem\b/i,
      /\bframework\b/i,
      /\bworkflow\b/i,
      /\bplatform\b/i,
      /\bseparate tool\b/i,
      /\bopen source\b/i
    ]
  },
  {
    label: "multi-step",
    weight: 4,
    patterns: [
      /\bend[- ]to[- ]end\b/i,
      /\bacross\b/i,
      /\bwhole repo\b/i,
      /\bcodebase\b/i,
      /\bmonorepo\b/i,
      /\ball my projects\b/i,
      /\bmultiple\b/i,
      /\bintegrate\b/i,
      /\bdeploy\b/i,
      /\brefactor\b/i
    ]
  },
  {
    label: "complex-debugging",
    weight: 4,
    patterns: [
      /\bdebug\b/i,
      /\broot cause\b/i,
      /\bflaky\b/i,
      /\bintermittent\b/i,
      /\brace condition\b/i,
      /\bdeadlock\b/i,
      /\bmemory leak\b/i,
      /\bregression\b/i,
      /\bperformance\b/i,
      /\bprofil(?:e|ing)\b/i
    ]
  },
  {
    label: "deepness-requested",
    weight: 3,
    patterns: [
      /\bdeep(?:ly)?\b/i,
      /\bthorough(?:ly)?\b/i,
      /\bcareful(?:ly)?\b/i,
      /\bexhaustive\b/i,
      /\bnovel\b/i,
      /\bnon-obvious\b/i
    ]
  }
];

const EFFORT_GUIDANCE = {
  minimal: "Use the fastest path. Avoid exploratory work unless the task unexpectedly widens.",
  low: "Keep the loop tight. Prefer direct edits, bounded reads, and minimal branching.",
  medium: "Default coding posture. Explore enough to avoid blind edits, then execute and verify.",
  high: "Use dependency-aware reasoning. Inspect surrounding systems, stage the work, and verify carefully.",
  xhigh: "Treat this as architecture or high-risk work. Front-load planning, verify assumptions, and keep an explicit risk log."
};

const PLAN_EFFORT = {
  minimal: "medium",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "xhigh"
};

const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    effort: {
      type: "string",
      enum: ["minimal", "low", "medium", "high", "xhigh"]
    },
    planEffort: {
      type: "string",
      enum: ["medium", "high", "xhigh"]
    },
    reason: {
      type: "string"
    },
    signals: {
      type: "array",
      items: {
        type: "string"
      }
    }
  },
  required: ["effort", "planEffort", "reason", "signals"],
  additionalProperties: false
};

const DEFAULT_ROUTING_MODE = "model";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 45000;
const VISIBLE_ROUTE_PREFIX = "[auto-route:";
const DEFAULT_TRANSCRIPT_TAIL_BYTES = 350_000;
const MAX_RECENT_MESSAGES = 6;
const MAX_SESSION_CANDIDATES = 12;
const EFFORT_RANK = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4
};

const textIncludesAny = (text, patterns) => patterns.some((pattern) => pattern.test(text));

const compactSnippet = (text) => text.replace(/\s+/g, " ").trim().slice(0, 180);

function joinNonEmpty(parts, separator = "\n") {
  return parts.map((value) => String(value || "").trim()).filter(Boolean).join(separator);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readFileTail(filePath, maxBytes = DEFAULT_TRANSCRIPT_TAIL_BYTES) {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const size = Number(stats.size || 0);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readFileHead(filePath, maxBytes = 4096) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function extractMessageTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (item?.type === "input_text" || item?.type === "output_text" || item?.type === "text") {
      parts.push(item.text || item.content || "");
      continue;
    }
    if (typeof item?.text === "string") {
      parts.push(item.text);
    }
  }
  return joinNonEmpty(parts, "\n");
}

function extractTranscriptMessage(record) {
  const payload = record?.payload || {};

  if (record?.type === "event_msg" && payload.type === "user_message" && payload.message) {
    return { role: "user", text: String(payload.message) };
  }

  if (record?.type === "event_msg" && payload.type === "task_complete" && payload.last_agent_message) {
    return { role: "assistant", text: String(payload.last_agent_message) };
  }

  if (record?.type === "response_item" && payload.type === "message" && payload.role) {
    const text = extractMessageTextFromContent(payload.content);
    if (text) {
      return { role: payload.role, text };
    }
  }

  return null;
}

function summarizeRecentMessages(messages) {
  return messages.map((message, index) =>
    `${index + 1}. ${message.role}: ${compactSnippet(message.text)}`
  ).join("\n");
}

function transcriptPathCandidatesRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

async function listRecentSessionFiles(rootDir) {
  const results = [];
  let years = [];
  try {
    years = (await fs.readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 2);
  } catch {
    return results;
  }

  for (const year of years) {
    const yearDir = path.join(rootDir, year);
    let months = [];
    try {
      months = (await fs.readdir(yearDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse()
        .slice(0, 2);
    } catch {
      continue;
    }

    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      let days = [];
      try {
        days = (await fs.readdir(monthDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
          .reverse()
          .slice(0, 4);
      } catch {
        continue;
      }

      for (const day of days) {
        const dayDir = path.join(monthDir, day);
        let files = [];
        try {
          files = (await fs.readdir(dayDir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => path.join(dayDir, entry.name))
            .sort()
            .reverse();
        } catch {
          continue;
        }
        results.push(...files);
        if (results.length >= MAX_SESSION_CANDIDATES) {
          return results.slice(0, MAX_SESSION_CANDIDATES);
        }
      }
    }
  }

  return results.slice(0, MAX_SESSION_CANDIDATES);
}

async function findLatestTranscriptForCwd(cwd) {
  if (!cwd) return null;
  const candidates = await listRecentSessionFiles(transcriptPathCandidatesRoot());
  const cwdToken = JSON.stringify(String(cwd));

  for (const candidate of candidates) {
    try {
      const head = await readFileHead(candidate);
      if (head.includes(cwdToken)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function loadTranscriptContext(transcriptPath) {
  if (!transcriptPath) return null;

  let tail;
  try {
    tail = await readFileTail(transcriptPath);
  } catch {
    return null;
  }

  const records = tail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeJsonParse)
    .filter(Boolean);

  const recentMessages = [];
  let modelContextWindow = null;
  let transcriptEffort = null;
  let transcriptModel = null;
  let transcriptCwd = null;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const payload = record?.payload || {};

    if (!modelContextWindow && record?.type === "event_msg" && payload.type === "task_started") {
      modelContextWindow = payload.model_context_window ?? null;
    }

    if (record?.type === "turn_context") {
      transcriptEffort ||= payload.effort ?? null;
      transcriptModel ||= payload.model ?? null;
      transcriptCwd ||= payload.cwd ?? null;
    }

    const message = extractTranscriptMessage(record);
    if (message && message.text) {
      recentMessages.unshift({
        role: message.role,
        text: compactSnippet(message.text)
      });
      if (recentMessages.length >= MAX_RECENT_MESSAGES) {
        break;
      }
    }
  }

  if (recentMessages.length === 0 && !modelContextWindow && !transcriptEffort) {
    return null;
  }

  return {
    transcriptPath,
    modelContextWindow,
    transcriptEffort,
    transcriptModel,
    transcriptCwd,
    recentMessages,
    recentMessagesSummary: summarizeRecentMessages(recentMessages),
    carryoverText: joinNonEmpty(recentMessages.map((message) => message.text), "\n")
  };
}

function parseGitStatus(statusText) {
  const lines = String(statusText || "").split("\n").filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  let branch = null;
  let changedLines = lines;
  if (lines[0].startsWith("## ")) {
    branch = lines[0].slice(3).trim();
    changedLines = lines.slice(1);
  }

  const changedPaths = changedLines
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    branch,
    changedFileCount: changedLines.length,
    changedPaths,
    isDirty: changedLines.length > 0,
    summary: changedLines.length > 0
      ? `${changedLines.length} changed file(s)${changedPaths.length ? `: ${changedPaths.join(", ")}` : ""}`
      : "clean worktree"
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (signal) {
        reject(new Error(`${command} terminated with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function loadWorkspaceContext(cwd) {
  if (!cwd) return null;

  try {
    const { stdout } = await runCommand(
      "git",
      ["-C", path.resolve(cwd), "status", "--short", "--branch", "--untracked-files=normal"],
      { cwd, timeoutMs: 2500 }
    );
    return parseGitStatus(stdout);
  } catch {
    return null;
  }
}

export async function collectRoutingContext(options = {}) {
  const transcriptPath = options.transcriptPath || await findLatestTranscriptForCwd(options.cwd || process.cwd());
  const transcript = await loadTranscriptContext(transcriptPath);
  const workspace = await loadWorkspaceContext(options.cwd || process.cwd());
  const previousDecision = options.previousDecision || null;

  const summaryLines = [];
  if (previousDecision?.effort) {
    summaryLines.push(`previous routed effort in this session: ${previousDecision.effort}`);
  }
  if (transcript?.modelContextWindow) {
    summaryLines.push(`model context window: ${transcript.modelContextWindow}`);
  }
  if (transcript?.transcriptEffort) {
    summaryLines.push(`latest transcript effort: ${transcript.transcriptEffort}`);
  }
  if (transcript?.recentMessagesSummary) {
    summaryLines.push(`recent thread context:\n${transcript.recentMessagesSummary}`);
  }
  if (workspace?.branch) {
    summaryLines.push(`workspace branch: ${workspace.branch}`);
  }
  if (workspace?.summary) {
    summaryLines.push(`workspace state: ${workspace.summary}`);
  }

  return {
    transcriptPath: transcript?.transcriptPath || null,
    transcript,
    workspace,
    previousDecision,
    summary: joinNonEmpty(summaryLines, "\n"),
    carryoverText: joinNonEmpty([
      previousDecision?.reason ? `previous routed reason: ${previousDecision.reason}` : "",
      transcript?.carryoverText || "",
      workspace?.summary ? `workspace summary: ${workspace.summary}` : ""
    ])
  };
}

function looksLikeShortStatusCheck(prompt, wordCount) {
  if (wordCount === 0 || wordCount > 12) return false;
  return (
    textIncludesAny(prompt, STATUS_PREFIX_PATTERNS) &&
    textIncludesAny(prompt, STATUS_ACTION_PATTERNS)
  );
}

function looksLikeShortFollowUp(prompt) {
  const normalized = String(prompt || "").trim();
  if (!normalized) return false;
  const wordCount = normalized.split(/\s+/).length;
  if (wordCount > 14) return false;
  return (
    normalized.endsWith("?") ||
    looksLikeShortStatusCheck(normalized, wordCount) ||
    /^(?:so|ok|okay|right|and|are|is|did|do|does|have|has|can|could|should|will|would)\b/i.test(normalized)
  );
}

function routingContextLooksActive(routingContext) {
  if (!routingContext) return false;
  if (routingContext.workspace?.changedFileCount > 0) return true;
  return textIncludesAny(
    String(routingContext.carryoverText || ""),
    FEATURE_GROUPS.flatMap((group) => group.patterns)
  );
}

function maybeApplyCarryoverFloor(decision, prompt, routingContext) {
  const previousEffort = routingContext?.previousDecision?.effort;
  if (!previousEffort || !["high", "xhigh"].includes(previousEffort)) {
    return decision;
  }
  if (!looksLikeShortFollowUp(prompt) || !routingContextLooksActive(routingContext)) {
    return decision;
  }
  if ((EFFORT_RANK[decision.effort] ?? 0) >= EFFORT_RANK[previousEffort]) {
    return decision;
  }

  return buildDecision({
    effort: previousEffort,
    planEffort: PLAN_EFFORT[previousEffort],
    score: decision.score,
    matchedSignals: [...decision.signals, "follow-up-carryover-floor"],
    promptSnippet: decision.promptSnippet,
    reason:
      `${decision.reason} The router preserved ${previousEffort} because this is a short follow-up inside an active high-complexity thread with unfinished workspace state.`,
    source: `${decision.source}-carryover`,
    classifierModel: decision.classifierModel,
    fallbackReason: decision.fallbackReason
  });
}

function selectEffort(score, matchedSignals) {
  const hasHighImpact = matchedSignals.includes("high-impact");
  const hasArchitecture = matchedSignals.includes("architecture");
  const hasResearch = matchedSignals.includes("research");

  if (hasHighImpact && (hasArchitecture || hasResearch || score >= 13)) return "xhigh";
  if (score >= 15) return "xhigh";
  if (score >= 8) return "high";
  if (score >= 3) return "medium";
  if (score >= 0) return "low";
  return "minimal";
}

function buildReason(prompt, effort, signals, score, contextSummary = null) {
  const signalText = signals.length > 0 ? signals.join(", ") : "default-medium";
  const effortLabel = effort === "xhigh" ? "extra-high" : effort;
  const baseReason = (
    `The task shape routes to ${effortLabel} effort ` +
    `(score ${score}; signals: ${signalText}) based on the prompt: "${compactSnippet(prompt)}".`
  );
  if (!contextSummary) {
    return baseReason;
  }
  return `${baseReason} Context considered: ${compactSnippet(contextSummary)}.`;
}

function buildRouteBanner(effort) {
  return `${VISIBLE_ROUTE_PREFIX} ${effort}]`;
}

function buildDecision({
  effort,
  planEffort,
  score = null,
  matchedSignals = [],
  promptSnippet,
  reason,
  source = "heuristic",
  classifierModel = null,
  fallbackReason = null
}) {
  const signals = Array.from(new Set(matchedSignals));
  const routeBanner = buildRouteBanner(effort);
  const visibilityInstruction =
    `Before your substantive response, print exactly "${routeBanner}" on its own line, then continue normally.`;
  const additionalContext =
    `Auto reasoning router target: ${effort}. ` +
    `Why: ${reason} ` +
    `Operating guidance: ${EFFORT_GUIDANCE[effort]} ` +
    visibilityInstruction;

  return {
    effort,
    planEffort,
    score,
    signals,
    promptSnippet,
    reason,
    guidance: EFFORT_GUIDANCE[effort],
    additionalContext,
    routeBanner,
    source,
    classifierModel,
    fallbackReason
  };
}

export function routePromptHeuristic(prompt, options = {}) {
  const rawPrompt = String(prompt || "").trim();
  const routingContext = options.routingContext || null;
  const carryoverText = String(routingContext?.carryoverText || "").trim();
  const contextualText = joinNonEmpty([rawPrompt, carryoverText], "\n");
  const wordCount = rawPrompt ? rawPrompt.split(/\s+/).length : 0;
  const matchedSignals = [];
  let score = 3;

  if (!rawPrompt) {
    return buildDecision({
      effort: "medium",
      planEffort: PLAN_EFFORT.medium,
      score,
      matchedSignals,
      promptSnippet: "",
      reason: "No prompt text was available, so the router fell back to the medium default."
    });
  }

  if (wordCount <= 8 && textIncludesAny(rawPrompt, MINIMAL_PATTERNS) && !carryoverText) {
    return buildDecision({
      effort: "minimal",
      planEffort: PLAN_EFFORT.minimal,
      score: -2,
      matchedSignals: ["direct-command"],
      promptSnippet: compactSnippet(rawPrompt),
      reason: "The prompt looks like a direct command or lookup, so extra reasoning would only add latency."
    });
  }

  if (textIncludesAny(rawPrompt, SIMPLE_PATTERNS)) {
    score -= 3;
    matchedSignals.push("simple-mechanical");
  }

  for (const group of FEATURE_GROUPS) {
    if (textIncludesAny(contextualText, group.patterns)) {
      score += group.weight;
      matchedSignals.push(group.label);
    }
  }

  if (carryoverText) {
    matchedSignals.push("thread-context");
    score += 1;
  }

  if (routingContext?.previousDecision?.effort === "high") {
    matchedSignals.push("recent-high-effort");
    score += 3;
  } else if (routingContext?.previousDecision?.effort === "xhigh") {
    matchedSignals.push("recent-xhigh-effort");
    score += 6;
  }

  if (routingContext?.workspace?.changedFileCount >= 2) {
    matchedSignals.push("dirty-worktree");
    score += 1;
  }
  if (routingContext?.workspace?.changedFileCount >= 6) {
    matchedSignals.push("wide-dirty-worktree");
    score += 2;
  }

  const hasElevatedRiskSignal = matchedSignals.some((signal) =>
    [
      "high-impact",
      "research",
      "architecture",
      "multi-step",
      "complex-debugging",
      "recent-high-effort",
      "recent-xhigh-effort"
    ].includes(signal)
  );

  if (!hasElevatedRiskSignal && looksLikeShortStatusCheck(rawPrompt, wordCount)) {
    score -= 3;
    matchedSignals.push("simple-status-check");
  }

  if (wordCount >= 80) {
    score += 2;
    matchedSignals.push("long-prompt");
  } else if (wordCount >= 35) {
    score += 1;
    matchedSignals.push("moderate-context");
  }

  if (/\b(?:and|then|after that|before that|while)\b/i.test(rawPrompt) && wordCount >= 24) {
    score += 1;
    matchedSignals.push("sequenced-work");
  }

  if (
    looksLikeShortStatusCheck(rawPrompt, wordCount) &&
    (matchedSignals.includes("recent-high-effort") || matchedSignals.includes("recent-xhigh-effort"))
  ) {
    matchedSignals.push("follow-up-carryover");
  }

  const effort = selectEffort(score, matchedSignals);
  const planEffort = PLAN_EFFORT[effort];
  const reason = buildReason(rawPrompt, effort, matchedSignals, score, routingContext?.summary || null);

  return buildDecision({
    effort,
    planEffort,
    score,
    matchedSignals,
    promptSnippet: compactSnippet(rawPrompt),
    reason
  });
}

export function buildCodexRoutingPrompt(prompt, routingContext = null) {
  return [
    "You are a routing model for Codex.",
    "",
    "Choose the smallest reasoning effort that is still sufficient for the user's prompt.",
    "Be specific and decisive.",
    "Base the decision on task shape, risk, ambiguity, verification burden, scope, and any supplied thread/workspace context.",
    "Do not classify the prompt in isolation if recent context shows ongoing work.",
    "",
    "Reasoning levels:",
    "- minimal: direct shell-like lookups or command-style requests with almost no judgment. Examples: \"what time is it\", \"pwd\", \"git status\", \"show me the version\".",
    "- low: short bounded conversational tasks, simple status checks, small rewrites, tiny edits, or straightforward confirmations. Examples: \"did you update the readme\", \"rename this variable\", \"rewrite this sentence\".",
    "- medium: standard coding, implementation, or analysis work that needs normal exploration but not heavy staging.",
    "- high: multi-step debugging, dependency-aware work, risky implementation, or verification-heavy changes.",
    "- xhigh: architecture, migrations, security, production-critical, or broad high-impact work.",
    "",
    "Important rule: status questions like \"did you update the readme\" are low, not minimal.",
    "Important rule: reserve minimal only for direct command-like lookups with almost no judgment.",
    "Important rule: choose the smallest sufficient effort, not the fanciest one.",
    "Important rule: if the latest prompt is a short follow-up inside an active refactor, debugging, migration, review, or architecture thread, keep the effort aligned to the ongoing work instead of downgrading just because the latest utterance is short.",
    "Important rule: use only the context provided below. If no context is supplied, route from the prompt alone.",
    "",
    "Context handling guidance:",
    "- OpenAI prompt guidance favors giving the model the relevant context it needs instead of making it guess missing state.",
    "- OpenAI reasoning guidance favors the smallest sufficient effort, but that should be judged from the whole task context, not the final sentence alone.",
    "",
    "Return only the schema.",
    "",
    "Supplied context:",
    routingContext?.summary || "(none)",
    "",
    "Prompt to classify:",
    JSON.stringify(String(prompt || ""))
  ].join("\n");
}

function normalizeModelDecision(rawDecision, prompt, options = {}) {
  const effort = KNOWN_EFFORTS.has(rawDecision?.effort) ? rawDecision.effort : "medium";
  const planEffort = ["medium", "high", "xhigh"].includes(rawDecision?.planEffort)
    ? rawDecision.planEffort
    : PLAN_EFFORT[effort];
  const signals = Array.isArray(rawDecision?.signals)
    ? rawDecision.signals.filter((value) => typeof value === "string" && value.trim())
    : [];
  const reason = typeof rawDecision?.reason === "string" && rawDecision.reason.trim()
    ? rawDecision.reason.trim()
    : `The model routed this task to ${effort} effort.`;

  return buildDecision({
    effort,
    planEffort,
    score: null,
    matchedSignals: signals,
    promptSnippet: compactSnippet(String(prompt || "")),
    reason,
    source: "model",
    classifierModel: options.classifierModel || null
  });
}

function normalizeErrorMessage(error) {
  const text = String(error?.message || error || "unknown router error").trim();
  return text.replace(/\s+/g, " ").slice(0, 300);
}

function spawnCodex(args, options = {}) {
  return runCommand("codex", args, options).catch((error) => {
    throw new Error(`codex router classifier failed: ${normalizeErrorMessage(error)}`);
  });
}

export async function classifyPromptWithCodex(prompt, options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-router-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "decision.json");
  const routingContext = options.routingContext || null;

  try {
    await fs.writeFile(schemaPath, `${JSON.stringify(ROUTER_SCHEMA, null, 2)}\n`, "utf8");

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-C",
      path.resolve(options.cwd || process.cwd()),
      "-c",
      "features.codex_hooks=false",
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      'plan_mode_reasoning_effort="medium"',
      "--output-schema",
      schemaPath,
      "-o",
      outputPath
    ];

    if (options.classifierModel) {
      args.push("--model", options.classifierModel);
    }

    args.push(buildCodexRoutingPrompt(prompt, routingContext));

    await spawnCodex(args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        CODEX_REASONING_ROUTER_CHILD: "1"
      },
      timeoutMs: options.timeoutMs
    });

    const rawOutput = await fs.readFile(outputPath, "utf8");
    const parsedOutput = JSON.parse(rawOutput);
    return normalizeModelDecision(parsedOutput, prompt, options);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function routePrompt(prompt, options = {}) {
  const mode = options.mode || process.env.CODEX_REASONING_ROUTER_MODE || DEFAULT_ROUTING_MODE;
  const routingContext = options.routingContext || await collectRoutingContext(options);

  if (mode !== "heuristic") {
    try {
      const classifier = options.modelRouter || classifyPromptWithCodex;
      const decision = await classifier(prompt, {
        ...options,
        routingContext
      });
      return maybeApplyCarryoverFloor(decision, prompt, routingContext);
    } catch (error) {
      if (mode === "model-only") {
        throw error;
      }
      const heuristicDecision = routePromptHeuristic(prompt, {
        routingContext
      });
      return buildDecision({
        effort: heuristicDecision.effort,
        planEffort: heuristicDecision.planEffort,
        score: heuristicDecision.score,
        matchedSignals: heuristicDecision.signals,
        promptSnippet: heuristicDecision.promptSnippet,
        source: "heuristic-fallback",
        fallbackReason: normalizeErrorMessage(error),
        reason:
          `${heuristicDecision.reason} ` +
          `The model-routed classifier was unavailable, so the router fell back to its local heuristic path.`
      });
    }
  }

  return routePromptHeuristic(prompt, {
    routingContext
  });
}

export function formatDecision(decision, format = "text") {
  if (format === "json") {
    return JSON.stringify(decision, null, 2);
  }
  if (format === "tsv") {
    return [
      decision.effort,
      decision.planEffort,
      decision.score ?? "",
      decision.signals.join(","),
      decision.reason
    ].join("\t");
  }
  return [
    `effort: ${decision.effort}`,
    `plan_effort: ${decision.planEffort}`,
    `score: ${decision.score ?? "n/a"}`,
    `source: ${decision.source ?? "unknown"}`,
    `classifier_model: ${decision.classifierModel ?? "current-codex-model"}`,
    `signals: ${decision.signals.join(", ") || "none"}`,
    `route_banner: ${decision.routeBanner}`,
    `reason: ${decision.reason}`,
    decision.fallbackReason ? `fallback_reason: ${decision.fallbackReason}` : null
  ].filter(Boolean).join("\n");
}

export const KNOWN_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
