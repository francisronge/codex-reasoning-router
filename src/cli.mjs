import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  readGlobalReasoningConfig,
  readRouterControlState,
  runPreToolUseHook,
  runSessionStartHook,
  runStopHook,
  runUserPromptSubmitHook,
  writeRouterControlState
} from "./hook.mjs";
import { installIntoCodexDir } from "./install.mjs";
import { formatDecision, routePrompt } from "./router.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "codex-reasoning-router.mjs");

function usage() {
  return [
    "codex-reasoning-router",
    "",
    "Commands:",
    "  classify [--heuristic] --prompt \"...\" [--json]",
    "  hook user-prompt-submit",
    "  launch [--heuristic-router] [codex args...] -- \"prompt text\"",
    "  install [--scope global|project] [--root DIR]",
    "  menubar [--foreground] [--path FILE]...",
    "  control status|pause|resume [--json]",
    ""
  ].join("\n");
}

function parseFlag(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}`);
  }
  args.splice(index, 2);
  return value;
}

function hasFlag(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function parseRepeatedFlags(args, flagName) {
  const values = [];
  while (true) {
    const index = args.indexOf(flagName);
    if (index === -1) break;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flagName}`);
    }
    values.push(value);
    args.splice(index, 2);
  }
  return values;
}

function resolvePromptFromLaunchArgs(args) {
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) {
    return {
      codexArgs: [...args],
      prompt: ""
    };
  }

  const codexArgs = args.slice(0, separatorIndex);
  const prompt = args.slice(separatorIndex + 1).join(" ").trim();
  return { codexArgs, prompt };
}

function hasReasoningOverride(args) {
  return args.some((arg, index) => {
    if (arg === "-c" || arg === "--config") {
      const nextArg = args[index + 1] || "";
      return nextArg.includes("model_reasoning_effort") || nextArg.includes("plan_mode_reasoning_effort");
    }
    return arg.includes("model_reasoning_effort") || arg.includes("plan_mode_reasoning_effort");
  });
}

async function runClassify(args) {
  const prompt = parseFlag(args, "--prompt") || args.join(" ");
  const format = hasFlag(args, "--json") ? "json" : "text";
  const mode = hasFlag(args, "--heuristic") ? "heuristic" : undefined;
  const config = await readGlobalReasoningConfig();
  const decision = await routePrompt(prompt, {
    cwd: process.cwd(),
    mode,
    classifierModel: config.model || undefined
  });
  process.stdout.write(`${formatDecision(decision, format)}\n`);
}

async function runHook(args) {
  const subcommand = args.shift();
  const stdinText = await readStdin();
  let payload;

  if (subcommand === "user-prompt-submit") {
    payload = await runUserPromptSubmitHook(stdinText);
  } else if (subcommand === "session-start") {
    payload = await runSessionStartHook(stdinText);
  } else if (subcommand === "pre-tool-use") {
    payload = await runPreToolUseHook(stdinText);
  } else if (subcommand === "stop") {
    payload = await runStopHook(stdinText);
  } else {
    throw new Error('Supported hook subcommands: "session-start", "user-prompt-submit", "pre-tool-use", "stop".');
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function runLaunch(args) {
  const dryRun = hasFlag(args, "--dry-run");
  const { codexArgs, prompt } = resolvePromptFromLaunchArgs(args);
  const mode = hasFlag(codexArgs, "--heuristic-router") ? "heuristic" : undefined;
  const config = await readGlobalReasoningConfig();
  const decision = await routePrompt(prompt, {
    cwd: process.cwd(),
    mode,
    classifierModel: config.model || undefined
  });
  const spawnedArgs = [...codexArgs];

  if (!hasReasoningOverride(spawnedArgs)) {
    spawnedArgs.push("-c", `model_reasoning_effort="${decision.effort}"`);
    spawnedArgs.push("-c", `plan_mode_reasoning_effort="${decision.planEffort}"`);
  }

  if (prompt) {
    spawnedArgs.push(prompt);
  }

  process.stderr.write(
    `[codex-reasoning-router] effort=${decision.effort} plan=${decision.planEffort} signals=${decision.signals.join(",") || "none"}\n`
  );

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ command: "codex", args: spawnedArgs, decision }, null, 2)}\n`);
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn("codex", spawnedArgs, {
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

async function runInstall(args) {
  const scope = parseFlag(args, "--scope") || "project";
  const root = parseFlag(args, "--root");
  const targetDir = scope === "global"
    ? path.join(os.homedir(), ".codex")
    : path.join(path.resolve(root || process.cwd()), ".codex");
  const hookCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} hook`;
  const result = await installIntoCodexDir({ targetDir, hookCommand });

  process.stdout.write(
    `${JSON.stringify(
      {
        scope,
        ...result
      },
      null,
      2
    )}\n`
  );
}

async function runMenubar(args) {
  const foreground = hasFlag(args, "--foreground");
  const paths = parseRepeatedFlags(args, "--path");
  const scriptPath = path.join(repoRoot, "scripts", "route-menubar.swift");
  const watchedPaths = paths.length > 0
    ? Array.from(new Set(paths.flatMap((watchedPath) => {
      const resolved = path.resolve(watchedPath);
      const livePath = resolved.endsWith("codex-reasoning-router-last-route.json")
        ? resolved.replace(/codex-reasoning-router-last-route\.json$/, "codex-reasoning-router-live.json")
        : null;
      return livePath ? [livePath, resolved] : [resolved];
    })))
    : [];
  const spawnedArgs = [scriptPath];

  for (const watchedPath of watchedPaths) {
    spawnedArgs.push("--path", watchedPath);
  }

  if (foreground) {
    await new Promise((resolve, reject) => {
      const child = spawn("swift", spawnedArgs, {
        stdio: "inherit",
        env: process.env
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 0;
        resolve();
      });
    });
    return;
  }

  const child = spawn("swift", spawnedArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  process.stdout.write(`${JSON.stringify({
    launched: true,
    mode: "menubar",
    pid: child.pid,
    scriptPath,
    paths: watchedPaths
  }, null, 2)}\n`);
}

async function runControl(args) {
  const subcommand = args.shift();
  const format = hasFlag(args, "--json") ? "json" : "text";

  let state;
  if (subcommand === "status" || !subcommand) {
    state = await readRouterControlState();
  } else if (subcommand === "pause") {
    state = await writeRouterControlState({
      routerEnabled: false,
      source: "cli-control"
    });
  } else if (subcommand === "resume") {
    state = await writeRouterControlState({
      routerEnabled: true,
      source: "cli-control"
    });
  } else {
    throw new Error('Supported control subcommands: "status", "pause", "resume".');
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `router_enabled: ${state.routerEnabled !== false}\nupdated_at: ${state.updatedAt ?? "n/a"}\nsource: ${state.source ?? "unknown"}\n`
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export async function main(argv) {
  const args = [...argv];
  const command = args.shift();

  switch (command) {
    case "classify":
      await runClassify(args);
      return;
    case "hook":
      await runHook(args);
      return;
    case "launch":
      await runLaunch(args);
      return;
    case "install":
      await runInstall(args);
      return;
    case "menubar":
      await runMenubar(args);
      return;
    case "control":
      await runControl(args);
      return;
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${usage()}`);
  }
}
