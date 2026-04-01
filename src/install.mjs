import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_SNIPPET = [
  'model_reasoning_effort = "medium"',
  'plan_mode_reasoning_effort = "high"',
  "",
  "[features]",
  "codex_hooks = true"
].join("\n");

function normalizeTargetDir(targetDir) {
  return path.resolve(targetDir);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function mergeConfig(configPath) {
  const exists = await fileExists(configPath);
  if (!exists) {
    await fs.writeFile(configPath, `${CONFIG_SNIPPET}\n`, "utf8");
    return { created: true, updated: true };
  }

  let source = await fs.readFile(configPath, "utf8");
  let updated = false;
  const prependLines = [];

  if (!/^\s*model_reasoning_effort\s*=.*$/m.test(source)) {
    prependLines.push('model_reasoning_effort = "medium"');
  }

  if (!/^\s*plan_mode_reasoning_effort\s*=.*$/m.test(source)) {
    prependLines.push('plan_mode_reasoning_effort = "high"');
  }

  if (prependLines.length > 0) {
    source = `${prependLines.join("\n")}\n${source}`;
    updated = true;
  }

  if (/^\s*\[features\]\s*$/m.test(source)) {
    if (!/^\s*codex_hooks\s*=.*$/m.test(source)) {
      source = source.replace(/^\s*\[features\]\s*$/m, "[features]\ncodex_hooks = true");
      updated = true;
    }
  } else {
    source = `${source.trimEnd()}\n\n[features]\ncodex_hooks = true\n`;
    updated = true;
  }

  if (updated) {
    await fs.writeFile(configPath, source, "utf8");
  }

  return { created: false, updated };
}

async function mergeHooks(hooksPath, commandString) {
  let source = { hooks: { SessionStart: [], UserPromptSubmit: [], PreToolUse: [], Stop: [] } };
  if (await fileExists(hooksPath)) {
    source = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    if (!source.hooks || typeof source.hooks !== "object") source.hooks = {};
    if (!Array.isArray(source.hooks.SessionStart)) source.hooks.SessionStart = [];
    if (!Array.isArray(source.hooks.UserPromptSubmit)) source.hooks.UserPromptSubmit = [];
    if (!Array.isArray(source.hooks.PreToolUse)) source.hooks.PreToolUse = [];
    if (!Array.isArray(source.hooks.Stop)) source.hooks.Stop = [];
  }

  const desired = [
    { event: "SessionStart", matcher: "", command: `${commandString} session-start` },
    { event: "UserPromptSubmit", matcher: "", command: `${commandString} user-prompt-submit` },
    { event: "PreToolUse", matcher: "Bash", command: `${commandString} pre-tool-use` },
    { event: "Stop", matcher: "", command: `${commandString} stop` }
  ];

  let updated = false;
  for (const item of desired) {
    const list = source.hooks[item.event];
    const exists = list.some((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return entry?.matcher === item.matcher &&
        hooks.some((hook) => hook?.type === "command" && hook?.command === item.command);
    });
    if (!exists) {
      list.push({
        matcher: item.matcher,
        hooks: [
          {
            type: "command",
            command: item.command
          }
        ]
      });
      updated = true;
    }
  }

  if (updated) {
    await fs.writeFile(hooksPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  }

  return { updated };
}

export async function installIntoCodexDir({
  targetDir,
  hookCommand
}) {
  const resolved = normalizeTargetDir(targetDir);
  await ensureDir(resolved);
  const configPath = path.join(resolved, "config.toml");
  const hooksPath = path.join(resolved, "hooks.json");

  const config = await mergeConfig(configPath);
  const hooks = await mergeHooks(hooksPath, hookCommand);

  return {
    codexDir: resolved,
    configPath,
    hooksPath,
    config,
    hooks
  };
}
