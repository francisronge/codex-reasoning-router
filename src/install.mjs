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

function emptyHooksShape() {
  return { hooks: { SessionStart: [], UserPromptSubmit: [], PreToolUse: [], Stop: [] } };
}

function normalizeHooksSource(source) {
  const normalized = source && typeof source === "object" ? source : emptyHooksShape();
  if (!normalized.hooks || typeof normalized.hooks !== "object") normalized.hooks = {};
  if (!Array.isArray(normalized.hooks.SessionStart)) normalized.hooks.SessionStart = [];
  if (!Array.isArray(normalized.hooks.UserPromptSubmit)) normalized.hooks.UserPromptSubmit = [];
  if (!Array.isArray(normalized.hooks.PreToolUse)) normalized.hooks.PreToolUse = [];
  if (!Array.isArray(normalized.hooks.Stop)) normalized.hooks.Stop = [];
  return normalized;
}

function desiredHookEntries(commandString) {
  return [
    { event: "SessionStart", matcher: "", command: `${commandString} session-start` },
    { event: "UserPromptSubmit", matcher: "", command: `${commandString} user-prompt-submit` },
    { event: "PreToolUse", matcher: "Bash", command: `${commandString} pre-tool-use` },
    { event: "Stop", matcher: "", command: `${commandString} stop` }
  ];
}

async function readHooksSource(hooksPath) {
  if (!await fileExists(hooksPath)) {
    return emptyHooksShape();
  }

  return normalizeHooksSource(JSON.parse(await fs.readFile(hooksPath, "utf8")));
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
  const source = await readHooksSource(hooksPath);
  const desired = desiredHookEntries(commandString);

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

export async function setHooksEnabledInCodexDir({
  targetDir,
  hookCommand,
  enabled
}) {
  const resolved = normalizeTargetDir(targetDir);
  const hooksPath = path.join(resolved, "hooks.json");
  const source = await readHooksSource(hooksPath);
  const desired = desiredHookEntries(hookCommand);
  let updated = false;

  if (enabled) {
    const merged = await mergeHooks(hooksPath, hookCommand);
    return {
      codexDir: resolved,
      hooksPath,
      hooksInstalled: true,
      updated: merged.updated
    };
  }

  for (const item of desired) {
    const list = source.hooks[item.event];
    const filtered = list
      .map((entry) => {
        const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
        const nextHooks = hooks.filter((hook) => !(hook?.type === "command" && hook?.command === item.command));
        if (nextHooks.length === hooks.length) {
          return entry;
        }
        updated = true;
        if (nextHooks.length === 0) {
          return null;
        }
        return {
          ...entry,
          hooks: nextHooks
        };
      })
      .filter(Boolean);
    source.hooks[item.event] = filtered;
  }

  if (updated) {
    await fs.writeFile(hooksPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  }

  return {
    codexDir: resolved,
    hooksPath,
    hooksInstalled: false,
    updated
  };
}

export async function readHookInstallState({
  targetDir,
  hookCommand
}) {
  const resolved = normalizeTargetDir(targetDir);
  const hooksPath = path.join(resolved, "hooks.json");
  const source = await readHooksSource(hooksPath);
  const desired = desiredHookEntries(hookCommand);

  const hooksInstalled = desired.every((item) => {
    const list = source.hooks[item.event];
    return list.some((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return entry?.matcher === item.matcher &&
        hooks.some((hook) => hook?.type === "command" && hook?.command === item.command);
    });
  });

  return {
    codexDir: resolved,
    hooksPath,
    hooksInstalled
  };
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
