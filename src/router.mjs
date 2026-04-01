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

const textIncludesAny = (text, patterns) => patterns.some((pattern) => pattern.test(text));

const compactSnippet = (text) => text.replace(/\s+/g, " ").trim().slice(0, 180);

export function routePrompt(prompt, options = {}) {
  const rawPrompt = String(prompt || "").trim();
  const text = rawPrompt.toLowerCase();
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

  const effort = selectEffort(score, matchedSignals, options);
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

function buildDecision({ effort, planEffort, score, matchedSignals, promptSnippet, reason }) {
  const signals = Array.from(new Set(matchedSignals));
  const additionalContext =
    `Auto reasoning router target: ${effort}. ` +
    `Why: ${reason} ` +
    `Operating guidance: ${EFFORT_GUIDANCE[effort]}`;

  return {
    effort,
    planEffort,
    score,
    signals,
    promptSnippet,
    reason,
    guidance: EFFORT_GUIDANCE[effort],
    additionalContext
  };
}

function buildReason(prompt, effort, signals, score) {
  const signalText = signals.length > 0 ? signals.join(", ") : "default-medium";
  const effortLabel = effort === "xhigh" ? "extra-high" : effort;
  return (
    `The task shape routes to ${effortLabel} effort ` +
    `(score ${score}; signals: ${signalText}) based on the prompt: "${compactSnippet(prompt)}".`
  );
}

export function formatDecision(decision, format = "text") {
  if (format === "json") {
    return JSON.stringify(decision, null, 2);
  }
  if (format === "tsv") {
    return [
      decision.effort,
      decision.planEffort,
      decision.score,
      decision.signals.join(","),
      decision.reason
    ].join("\t");
  }
  return [
    `effort: ${decision.effort}`,
    `plan_effort: ${decision.planEffort}`,
    `score: ${decision.score}`,
    `signals: ${decision.signals.join(", ") || "none"}`,
    `reason: ${decision.reason}`
  ].join("\n");
}

export const KNOWN_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
