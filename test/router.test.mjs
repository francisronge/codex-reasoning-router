import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCodexRoutingPrompt, routePrompt, routePromptHeuristic } from "../src/router.mjs";

const EMPTY_CONTEXT = {
  summary: "",
  carryoverText: "",
  workspace: null,
  previousDecision: null
};

test("routes direct command prompts to low with heuristic mode", async () => {
  const decision = await routePrompt("what time is it", { mode: "heuristic", routingContext: EMPTY_CONTEXT });
  assert.equal(decision.effort, "low");
  assert.equal(decision.source, "heuristic");
});

test("routes simple mechanical edits to low with heuristic mode", async () => {
  const decision = await routePrompt("rename this variable and fix the typo", { mode: "heuristic", routingContext: EMPTY_CONTEXT });
  assert.equal(decision.effort, "low");
});

test("routes short status checks to low with heuristic mode", async () => {
  const decision = await routePrompt("did you update the readme", { mode: "heuristic", routingContext: EMPTY_CONTEXT });
  assert.equal(decision.effort, "low");
});

test("keeps high-risk status checks elevated with heuristic mode", async () => {
  const decision = await routePrompt("did you fix the production auth migration", { mode: "heuristic", routingContext: EMPTY_CONTEXT });
  assert.equal(decision.effort, "high");
});

test("routes normal coding work to medium with heuristic mode", async () => {
  const decision = await routePrompt("implement a small API endpoint and add a test", { mode: "heuristic", routingContext: EMPTY_CONTEXT });
  assert.equal(decision.effort, "medium");
});

test("routes multi-step debugging to high with heuristic mode", async () => {
  const decision = await routePrompt(
    "debug the flaky CI regression, find the root cause, and verify the fix across the repo",
    { mode: "heuristic", routingContext: EMPTY_CONTEXT }
  );
  assert.equal(decision.effort, "high");
});

test("routes architecture and high-impact tasks to xhigh with heuristic mode", async () => {
  const decision = await routePrompt(
    "design an open source Codex-wide reasoning router for all my projects and make sure migrations are safe",
    { mode: "heuristic", routingContext: EMPTY_CONTEXT }
  );
  assert.equal(decision.effort, "xhigh");
});

test("keeps short follow-ups elevated when thread context is still complex", async () => {
  const decision = await routePrompt("so are we done?", {
    mode: "heuristic",
    routingContext: {
      previousDecision: {
        effort: "xhigh",
        reason: "The thread is still in the middle of a refactor and blocker investigation."
      },
      workspace: {
        changedFileCount: 2,
        summary: "2 changed file(s): geminiParser.js, .env.example"
      },
      carryoverText: "mid refactor strict Babel-side contract live INVALID_REQUEST blocker debug the runtime path",
      summary: "previous routed effort in this session: xhigh\nrecent thread context:\n1. assistant: mid refactor strict Babel-side contract live blocker"
    }
  });

  assert.equal(decision.effort, "xhigh");
  assert.match(decision.reason, /context considered/i);
});

test("uses the exact active session binding for terse follow-ups", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-router-context-"));
  const cwd = path.join(tempRoot, "workspace");
  const stateDir = path.join(cwd, ".codex", "state");
  const transcriptPath = path.join(tempRoot, "session.jsonl");

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "codex-reasoning-router-active-session.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      cwd,
      sessionId: "session-123",
      transcriptPath,
      phase: "selected",
      lastDecision: {
        effort: "xhigh",
        reason: "The thread is in the middle of a refactor and blocker investigation."
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: "turn_context",
        payload: {
          cwd,
          effort: "xhigh",
          model: "gpt-5.4"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "We are still debugging a live blocker in the middle of the refactor and need to verify the contract."
            }
          ]
        }
      })
    ].join("\n"),
    "utf8"
  );

  try {
    const decision = await routePrompt("so are we done?", {
      mode: "heuristic",
      cwd
    });

    assert.equal(decision.effort, "xhigh");
    assert.match(decision.signals.join(" "), /recent-xhigh-effort/);
    assert.match(decision.signals.join(" "), /active-refactor/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("uses model router decisions by default", async () => {
  const decision = await routePrompt("did you update the readme", {
    routingContext: EMPTY_CONTEXT,
    modelRouter: async () => ({
      effort: "low",
      planEffort: "medium",
      score: null,
      signals: ["status question"],
      promptSnippet: "did you update the readme",
      reason: "Model classified this as a bounded status question.",
      guidance: "",
      additionalContext: "",
      routeBanner: "[auto-route: low]",
      source: "model",
      classifierModel: "gpt-5.4"
    })
  });

  assert.equal(decision.effort, "low");
  assert.equal(decision.source, "model");
});

test("model routing keeps short follow-ups at prior xhigh effort when the thread is still active", async () => {
  const decision = await routePrompt("so are we done?", {
    routingContext: {
      previousDecision: {
        effort: "xhigh",
        reason: "The thread is still in the middle of a large refactor."
      },
      workspace: {
        changedFileCount: 2,
        summary: "2 changed file(s): geminiParser.js, .env.example"
      },
      carryoverText: "active refactor runtime blocker strict contract",
      summary: "previous routed effort in this session: xhigh"
    },
    modelRouter: async () => ({
      effort: "medium",
      planEffort: "high",
      score: null,
      signals: ["short follow-up"],
      promptSnippet: "so are we done?",
      reason: "Model classified this as a context-aware follow-up.",
      guidance: "",
      additionalContext: "",
      routeBanner: "[auto-route: medium]",
      source: "model",
      classifierModel: "gpt-5.4"
    })
  });

  assert.equal(decision.effort, "xhigh");
  assert.equal(decision.source, "model-carryover");
});

test("routing prompt includes supplied thread context", () => {
  const prompt = buildCodexRoutingPrompt("so are we done?", {
    summary: "previous routed effort in this session: xhigh\nrecent thread context:\n1. user: continue the refactor"
  });

  assert.match(prompt, /Do not classify the prompt in isolation/i);
  assert.match(prompt, /previous routed effort in this session: xhigh/i);
  assert.match(prompt, /recent thread context/i);
});

test("falls back to heuristic routing when the model router fails", async () => {
  const decision = await routePrompt("rename this variable", {
    routingContext: EMPTY_CONTEXT,
    modelRouter: async () => {
      throw new Error("classifier unavailable");
    }
  });

  assert.equal(decision.effort, "low");
  assert.equal(decision.source, "heuristic-fallback");
  assert.match(decision.fallbackReason, /classifier unavailable/i);
});

test("heuristic decisions include a visible route banner", () => {
  const decision = routePromptHeuristic("rename this variable");
  assert.equal(decision.routeBanner, "[auto-route: low]");
  assert.match(decision.additionalContext, /\[auto-route: low\]/);
});
