import test from "node:test";
import assert from "node:assert/strict";

import { routePrompt } from "../src/router.mjs";

test("routes direct command prompts to minimal", () => {
  const decision = routePrompt("what time is it");
  assert.equal(decision.effort, "minimal");
});

test("routes simple mechanical edits to low", () => {
  const decision = routePrompt("rename this variable and fix the typo");
  assert.equal(decision.effort, "low");
});

test("routes normal coding work to medium", () => {
  const decision = routePrompt("implement a small API endpoint and add a test");
  assert.equal(decision.effort, "medium");
});

test("routes multi-step debugging to high", () => {
  const decision = routePrompt("debug the flaky CI regression, find the root cause, and verify the fix across the repo");
  assert.equal(decision.effort, "high");
});

test("routes architecture and high-impact tasks to xhigh", () => {
  const decision = routePrompt("design an open source Codex-wide reasoning router for all my projects and make sure migrations are safe");
  assert.equal(decision.effort, "xhigh");
});
