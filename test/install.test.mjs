import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installIntoCodexDir, readHookInstallState, setHooksEnabledInCodexDir } from "../src/install.mjs";

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

test("disable removes only CRR hooks and enable restores them", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-router-install-"));
  const codexDir = path.join(tempDir, ".codex");
  const hookCommand = '"/usr/bin/node" "/tool" hook';

  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(
    path.join(codexDir, "hooks.json"),
    `${JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "\"/usr/bin/node\" \"/other-tool\" hook session-start"
              }
            ]
          }
        ],
        UserPromptSubmit: [],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "\"/usr/bin/node\" \"/other-tool\" hook pre-tool-use"
              }
            ]
          }
        ],
        Stop: []
      }
    }, null, 2)}\n`,
    "utf8"
  );

  await installIntoCodexDir({ targetDir: codexDir, hookCommand });
  let hookState = await readHookInstallState({ targetDir: codexDir, hookCommand });
  assert.equal(hookState.hooksInstalled, true);

  await setHooksEnabledInCodexDir({
    targetDir: codexDir,
    hookCommand,
    enabled: false
  });

  hookState = await readHookInstallState({ targetDir: codexDir, hookCommand });
  assert.equal(hookState.hooksInstalled, false);

  let hooksJson = JSON.parse(await fs.readFile(path.join(codexDir, "hooks.json"), "utf8"));
  assert.equal(
    hooksJson.hooks.UserPromptSubmit.some((entry) =>
      entry.hooks.some((hook) => String(hook.command || "").includes('"/tool" hook user-prompt-submit'))
    ),
    false
  );
  assert.equal(
    hooksJson.hooks.SessionStart.some((entry) =>
      entry.hooks.some((hook) => String(hook.command || "").includes('"/other-tool" hook session-start'))
    ),
    true
  );
  assert.equal(
    hooksJson.hooks.PreToolUse.some((entry) =>
      entry.hooks.some((hook) => String(hook.command || "").includes('"/other-tool" hook pre-tool-use'))
    ),
    true
  );

  await setHooksEnabledInCodexDir({
    targetDir: codexDir,
    hookCommand,
    enabled: true
  });

  hookState = await readHookInstallState({ targetDir: codexDir, hookCommand });
  assert.equal(hookState.hooksInstalled, true);

  hooksJson = JSON.parse(await fs.readFile(path.join(codexDir, "hooks.json"), "utf8"));
  assert.equal(
    hooksJson.hooks.SessionStart.some((entry) =>
      entry.hooks.some((hook) => String(hook.command || "").includes('"/tool" hook session-start'))
    ),
    true
  );
  assert.equal(
    hooksJson.hooks.UserPromptSubmit.some((entry) =>
      entry.hooks.some((hook) => String(hook.command || "").includes('"/tool" hook user-prompt-submit'))
    ),
    true
  );
  assert.equal(
    hooksJson.hooks.PreToolUse.some((entry) =>
      entry.hooks.some((hook) => String(hook.command || "").includes('"/tool" hook pre-tool-use'))
    ),
    true
  );
  assert.equal(
    hooksJson.hooks.Stop.some((entry) =>
      entry.hooks.some((hook) => String(hook.command || "").includes('"/tool" hook stop'))
    ),
    true
  );
});
