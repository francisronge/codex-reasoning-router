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

const textIncludesAny = (text, patterns) => patterns.some((pattern) => pattern.test(text));

const compactSnippet = (text) => text.replace(/\s+/g, " ").trim().slice(0, 180);

function looksLikeShortStatusCheck(prompt, wordCount) {
  if (wordCount === 0 || wordCount > 12) return false;
  return (
    textIncludesAny(prompt, STATUS_PREFIX_PATTERNS) &&
    textIncludesAny(prompt, STATUS_ACTION_PATTERNS)
  );
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

function buildReason(prompt, effort, signals, score) {
  const signalText = signals.length > 0 ? signals.join(", ") : "default-medium";
  const effortLabel = effort === "xhigh" ? "extra-high" : effort;
  return (
    `The task shape routes to ${effortLabel} effort ` +
    `(score ${score}; signals: ${signalText}) based on the prompt: "${compactSnippet(prompt)}".`
  );
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

export function routePromptHeuristic(prompt) {
  const rawPrompt = String(prompt || "").trim();
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

  if (wordCount <= 8 && textIncludesAny(rawPrompt, MINIMAL_PATTERNS)) {
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
    if (textIncludesAny(rawPrompt, group.patterns)) {
      score += group.weight;
      matchedSignals.push(group.label);
    }
  }

  const hasElevatedRiskSignal = matchedSignals.some((signal) =>
    ["high-impact", "research", "architecture", "multi-step", "complex-debugging"].includes(signal)
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

  const effort = selectEffort(score, matchedSignals);
  const planEffort = PLAN_EFFORT[effort];
  const reason = buildReason(rawPrompt, effort, matchedSignals, score);

  return buildDecision({
    effort,
    planEffort,
    score,
    matchedSignals,
    promptSnippet: compactSnippet(rawPrompt),
    reason
  });
}

function buildCodexRoutingPrompt(prompt) {
  return [
    "You are a routing model for Codex.",
    "",
    "Choose the smallest reasoning effort that is still sufficient for the user's prompt.",
    "Be specific and decisive.",
    "Base the decision on task shape, risk, ambiguity, verification burden, and scope.",
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
    "",
    "Return only the schema.",
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
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
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
        reject(new Error(`codex router classifier terminated with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `codex router classifier failed with exit code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function classifyPromptWithCodex(prompt, options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-router-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "decision.json");

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

    args.push(buildCodexRoutingPrompt(prompt));

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

  if (mode !== "heuristic") {
    try {
      const classifier = options.modelRouter || classifyPromptWithCodex;
      return await classifier(prompt, options);
    } catch (error) {
      if (mode === "model-only") {
        throw error;
      }
      const heuristicDecision = routePromptHeuristic(prompt);
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

  return routePromptHeuristic(prompt);
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
