import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { runStopHook, runUserPromptSubmitHook } from "../src/hook.mjs";

test("replay flow injects a visible route banner into Codex", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-router-hook-"));
  const codexHome = path.join(tempRoot, "home");
  const cwd = path.join(tempRoot, "workspace");
  const previousHome = process.env.CODEX_HOME;
  const previousMode = process.env.CODEX_REASONING_ROUTER_MODE;

  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    'model = "gpt-5.4"\nmodel_reasoning_effort = "medium"\nplan_mode_reasoning_effort = "high"\n',
    "utf8"
  );

  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_REASONING_ROUTER_MODE = "heuristic";

  try {
    const firstTurn = await runUserPromptSubmitHook(JSON.stringify({
      prompt: "rename this variable",
      cwd,
      session_id: "test-session",
      turn_id: "turn-1"
    }));

    assert.match(firstTurn.hookSpecificOutput.additionalContext, /ROUTER_PRECHECK/);

    const stopResult = await runStopHook(JSON.stringify({
      cwd,
      session_id: "test-session",
      stop_hook_active: false
    }));

    assert.equal(stopResult.decision, "block");

    const replayTurn = await runUserPromptSubmitHook(JSON.stringify({
      prompt: "rename this variable",
      cwd,
      session_id: "test-session",
      turn_id: "turn-2"
    }));

    assert.match(replayTurn.hookSpecificOutput.additionalContext, /\[auto-route: low\]/);
    assert.match(replayTurn.hookSpecificOutput.additionalContext, /Perform the user's request normally now/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;

    if (previousMode === undefined) delete process.env.CODEX_REASONING_ROUTER_MODE;
    else process.env.CODEX_REASONING_ROUTER_MODE = previousMode;

    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
