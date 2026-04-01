import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installIntoCodexDir } from "../src/install.mjs";

test("install is idempotent and does not duplicate reasoning keys", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-router-install-"));
  const codexDir = path.join(tempDir, ".codex");
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(
    path.join(codexDir, "config.toml"),
    'model = "gpt-5.4"\nmodel_reasoning_effort = "xhigh"\n[features]\nmulti_agent = true\n',
    "utf8"
  );

  await installIntoCodexDir({ targetDir: codexDir, hookCommand: '"/usr/bin/node" "/tool" hook' });
  await installIntoCodexDir({ targetDir: codexDir, hookCommand: '"/usr/bin/node" "/tool" hook' });

  const configText = await fs.readFile(path.join(codexDir, "config.toml"), "utf8");
  const hooksText = await fs.readFile(path.join(codexDir, "hooks.json"), "utf8");

  assert.equal((configText.match(/^model_reasoning_effort\s*=/gm) || []).length, 1);
  assert.equal((configText.match(/^plan_mode_reasoning_effort\s*=/gm) || []).length, 1);
  assert.match(hooksText, /SessionStart/);
  assert.match(hooksText, /UserPromptSubmit/);
  assert.match(hooksText, /PreToolUse/);
  assert.match(hooksText, /Stop/);
});
