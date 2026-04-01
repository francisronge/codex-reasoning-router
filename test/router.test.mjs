import test from "node:test";
import assert from "node:assert/strict";

import { routePrompt, routePromptHeuristic } from "../src/router.mjs";

test("routes direct command prompts to minimal with heuristic mode", async () => {
  const decision = await routePrompt("what time is it", { mode: "heuristic" });
  assert.equal(decision.effort, "minimal");
  assert.equal(decision.source, "heuristic");
});

test("routes simple mechanical edits to low with heuristic mode", async () => {
  const decision = await routePrompt("rename this variable and fix the typo", { mode: "heuristic" });
  assert.equal(decision.effort, "low");
});

test("routes short status checks to low with heuristic mode", async () => {
  const decision = await routePrompt("did you update the readme", { mode: "heuristic" });
  assert.equal(decision.effort, "low");
});

test("keeps high-risk status checks elevated with heuristic mode", async () => {
  const decision = await routePrompt("did you fix the production auth migration", { mode: "heuristic" });
  assert.equal(decision.effort, "high");
});

test("routes normal coding work to medium with heuristic mode", async () => {
  const decision = await routePrompt("implement a small API endpoint and add a test", { mode: "heuristic" });
  assert.equal(decision.effort, "medium");
});

test("routes multi-step debugging to high with heuristic mode", async () => {
  const decision = await routePrompt(
    "debug the flaky CI regression, find the root cause, and verify the fix across the repo",
    { mode: "heuristic" }
  );
  assert.equal(decision.effort, "high");
});

test("routes architecture and high-impact tasks to xhigh with heuristic mode", async () => {
  const decision = await routePrompt(
    "design an open source Codex-wide reasoning router for all my projects and make sure migrations are safe",
    { mode: "heuristic" }
  );
  assert.equal(decision.effort, "xhigh");
});

test("uses model router decisions by default", async () => {
  const decision = await routePrompt("did you update the readme", {
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

test("falls back to heuristic routing when the model router fails", async () => {
  const decision = await routePrompt("rename this variable", {
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
