import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KNOWN_EFFORTS, routePrompt } from "./router.mjs";

const FORCE_VISIBLE_REPLAY = process.env.CODEX_REASONING_ROUTER_FORCE_REPLAY !== "0";

function defaultLogPath(cwd) {
  const baseDir = cwd ? path.join(cwd, ".codex", "state") : path.join(os.homedir(), ".codex", "state");
  return path.join(baseDir, "codex-reasoning-router-last-route.json");
}

function resolveCodexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function resolveStateDir(cwd) {
  return cwd ? path.join(cwd, ".codex", "state") : path.join(resolveCodexHome(), "state");
}

function sessionStatePath(cwd, sessionId) {
  const sessionKey = String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(resolveStateDir(cwd), `codex-reasoning-router-session-${sessionKey}.json`);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseEffortValue(configText, key, fallback) {
  const match = configText.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  const value = String(match?.[1] || "").trim();
  return KNOWN_EFFORTS.has(value) ? value : fallback;
}

function parseStringValue(configText, key, fallback = null) {
  const match = configText.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  const value = String(match?.[1] || "").trim();
  return value || fallback;
}

export async function readGlobalReasoningConfig() {
  const configPath = path.join(resolveCodexHome(), "config.toml");
  let configText = "";
  try {
    configText = await fs.readFile(configPath, "utf8");
  } catch {
    return {
      configPath,
      configText: "",
      model: null,
      modelReasoningEffort: "medium",
      planModeReasoningEffort: "high"
    };
  }

  return {
    configPath,
    configText,
    model: parseStringValue(configText, "model", null),
    modelReasoningEffort: parseEffortValue(configText, "model_reasoning_effort", "medium"),
    planModeReasoningEffort: parseEffortValue(configText, "plan_mode_reasoning_effort", "high")
  };
}

function replaceOrInsertTomlKey(source, key, value) {
  const line = `${key} = "${value}"`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  return `${line}\n${source}`;
}

export async function writeGlobalReasoningConfig({ modelReasoningEffort, planModeReasoningEffort }) {
  const { configPath, configText } = await readGlobalReasoningConfig();
  let next = configText || "";
  next = replaceOrInsertTomlKey(next, "model_reasoning_effort", modelReasoningEffort);
  next = replaceOrInsertTomlKey(next, "plan_mode_reasoning_effort", planModeReasoningEffort);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, next, "utf8");
}

async function appendTrace(logPath, payload) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function restoreStateConfig(state) {
  if (!state?.previousEffort || !state?.previousPlanEffort) return false;
  await writeGlobalReasoningConfig({
    modelReasoningEffort: state.previousEffort,
    planModeReasoningEffort: state.previousPlanEffort
  });
  return true;
}

async function markStateRestored(statePath, state, reason) {
  await writeJson(statePath, {
    ...state,
    phase: "restored",
    restoredAt: new Date().toISOString(),
    restoreReason: reason
  });
}

async function maybeRestoreLingeringSessionState(cwd, sessionId, reason) {
  const statePath = sessionStatePath(cwd, sessionId);
  const state = await readJson(statePath, null);
  if (state?.phase === "replay_pending") {
    await restoreStateConfig(state);
    await markStateRestored(statePath, state, reason);
    return true;
  }
  return false;
}

async function restoreAnyLingeringStateInDir(stateDir, reason) {
  let entries = [];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.startsWith("codex-reasoning-router-session-") || !entry.endsWith(".json")) continue;
    const fullPath = path.join(stateDir, entry);
    const state = await readJson(fullPath, null);
    if (state?.phase === "replay_pending") {
      await restoreStateConfig(state);
      await markStateRestored(fullPath, state, reason);
      return true;
    }
  }

  return false;
}

function buildPreflightContext(decision) {
  return (
    `Auto reasoning router preflight. The task was routed to ${decision.effort} reasoning effort. ` +
    `Do not start substantive work, do not inspect files, do not run tools, and do not ask questions yet. ` +
    `Reply with exactly ROUTER_PRECHECK.`
  );
}

function buildReplayContext(decision) {
  return (
    `Auto reasoning router replay. Reasoning has been retargeted to ${decision.effort} ` +
    `with planning at ${decision.planEffort}. Perform the user's request normally now. ` +
    `${decision.guidance} ` +
    `Before anything else, print exactly "${decision.routeBanner}" on its own line, then continue normally.`
  );
}

function buildReplayPrompt(state) {
  return [
    `Auto reasoning router replay.`,
    `The routed effort for this task is ${state.decision.effort}.`,
    `Your first line must be exactly "${state.decision.routeBanner}".`,
    `After that, answer the user's original request normally.`,
    "",
    `Original prompt:`,
    state.originalPrompt
  ].join("\n");
}

export async function runUserPromptSubmitHook(stdinText, options = {}) {
  const payload = JSON.parse(stdinText || "{}");
  const prompt = String(payload.prompt || "");
  const config = await readGlobalReasoningConfig();
  const statePath = sessionStatePath(payload.cwd, payload.session_id);
  const existingState = await readJson(statePath, null);
  if (existingState?.phase !== "replay_pending") {
    await maybeRestoreLingeringSessionState(payload.cwd, payload.session_id, "next-user-prompt");
  }
  const currentState = existingState?.phase === "replay_pending"
    ? existingState
    : await readJson(statePath, null);
  const logPath = options.logPath || defaultLogPath(payload.cwd);
  const currentEffort = config.modelReasoningEffort;
  const currentPlanEffort = config.planModeReasoningEffort;

  if (currentState?.phase === "replay_pending") {
    const replayState = {
      ...currentState,
      turnId: payload.turn_id || currentState.turnId || null,
      phase: "replay_active"
    };
    await writeJson(statePath, replayState);
    await appendTrace(logPath, {
      timestamp: new Date().toISOString(),
      cwd: payload.cwd || null,
      sessionId: payload.session_id || null,
      transcriptPath: payload.transcript_path || null,
      prompt,
      decision: replayState.decision,
      currentEffort,
      currentPlanEffort,
      statePhase: replayState.phase
    });
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildReplayContext(replayState.decision)
      }
    };
  }

  const decision = await routePrompt(prompt, {
    cwd: payload.cwd || process.cwd(),
    classifierModel: config.model || undefined
  });

  let additionalContext = decision.additionalContext;
  let state = currentState;
  const needsReplay =
    FORCE_VISIBLE_REPLAY ||
    decision.effort !== currentEffort ||
    decision.planEffort !== currentPlanEffort;

  state = {
    sessionId: payload.session_id || null,
    cwd: payload.cwd || null,
    turnId: payload.turn_id || null,
    originalPrompt: prompt,
    decision,
    previousEffort: currentEffort,
    previousPlanEffort: currentPlanEffort,
    phase: needsReplay ? "precheck_pending" : "direct"
  };

  additionalContext = needsReplay ? buildPreflightContext(decision) : decision.additionalContext;
  await writeJson(statePath, state);

  await appendTrace(logPath, {
    timestamp: new Date().toISOString(),
    cwd: payload.cwd || null,
    sessionId: payload.session_id || null,
    transcriptPath: payload.transcript_path || null,
    prompt,
    decision,
    currentEffort,
    currentPlanEffort,
    statePhase: state?.phase || null
  });

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext
    }
  };
}

export async function runPreToolUseHook(stdinText) {
  const payload = JSON.parse(stdinText || "{}");
  const statePath = sessionStatePath(payload.cwd, payload.session_id);
  const state = await readJson(statePath, null);

  if (
    state &&
    state.phase === "precheck_pending" &&
    state.turnId &&
    payload.turn_id === state.turnId
  ) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Auto reasoning router preflight forbids tool use before replay."
      }
    };
  }

  return {};
}

export async function runStopHook(stdinText) {
  const payload = JSON.parse(stdinText || "{}");
  const statePath = sessionStatePath(payload.cwd, payload.session_id);
  const state = await readJson(statePath, null);

  if (!state) {
    return { decision: "continue" };
  }

  if (state.phase === "precheck_pending" && !payload.stop_hook_active) {
    await writeGlobalReasoningConfig({
      modelReasoningEffort: state.decision.effort,
      planModeReasoningEffort: state.decision.planEffort
    });
    await writeJson(statePath, {
      ...state,
      phase: "replay_pending"
    });
    return {
      decision: "block",
      reason: buildReplayPrompt(state)
    };
  }

  if (state.phase === "replay_active") {
    await writeGlobalReasoningConfig({
      modelReasoningEffort: state.previousEffort || "medium",
      planModeReasoningEffort: state.previousPlanEffort || "high"
    });
    await writeJson(statePath, {
      ...state,
      phase: "done",
      completedAt: new Date().toISOString()
    });
    return { decision: "continue" };
  }

  if (state.phase === "replay_pending" && payload.stop_hook_active) {
    await restoreStateConfig(state);
    await markStateRestored(statePath, state, "stop-hook-active");
    return { decision: "continue" };
  }

  return { decision: "continue" };
}

export async function runSessionStartHook(stdinText) {
  const payload = JSON.parse(stdinText || "{}");
  const restored = await restoreAnyLingeringStateInDir(
    resolveStateDir(payload.cwd),
    "session-start"
  );

  if (!restored) {
    await restoreAnyLingeringStateInDir(path.join(resolveCodexHome(), "state"), "session-start-home");
  }

  return {};
}
