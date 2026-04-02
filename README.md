# codex-reasoning-router

`codex-reasoning-router` is a standalone helper for Codex that classifies task shape and routes reasoning effort before work starts.

It is built around three realities:

1. The OpenAI prompt guidance recommends choosing reasoning effort based on task shape, not just always using the highest setting.
2. Current Codex hooks can add context on `UserPromptSubmit`, and `Stop` can automatically create a continuation turn.
3. Codex itself can classify prompts with a strict JSON schema, so the routing decision can be model-based instead of pure regex.
4. A short follow-up inside an active refactor or debugging thread should inherit that thread’s complexity instead of being classified in isolation.

Because of that, the tool ships two complementary paths:

- `launch`: the real pre-run router. It chooses an effort level, then starts Codex with `-c model_reasoning_effort=...`.
- `hook`: the always-on in-Codex router. It uses a light preflight turn plus a `Stop` replay turn to retarget reasoning before substantive work starts.

By default, routing is model-based:

- the router asks Codex itself to classify the prompt with a schema-constrained output
- the local heuristic path only runs as a fallback if the model classifier is unavailable
- the router can include recent Codex thread context, prior routed effort, and current workspace state when choosing effort
- the first substantive response includes a visible route banner such as `[auto-route: low]`
- on macOS, the optional menubar watcher can show the latest route as `CRR LOW`, `CRR HIGH`, or `CRR XHIGH`
- when hook files are stale in the desktop app, the menubar watcher can also listen for Return in Codex, OCR the visible composer, and classify the prompt at send-time

## Install

Fastest path from a local checkout:

```bash
bash ./scripts/bootstrap-local.sh
```

That makes the command available globally from this checkout and installs the Codex hooks into `~/.codex`.

Manual install:

```bash
npm link
codex-reasoning-router install --scope global
```

That creates or updates:

- `~/.codex/config.toml`
- `~/.codex/hooks.json`

For a transparent all-project workflow across Babel and your other repos on this machine, wrap `codex` itself:

```bash
codex-auto() {
  codex-reasoning-router launch "$@"
}
```

Then use:

```bash
codex-auto --full-auto -- "fix the flaky CI regression"
```

Because the hooks live in `~/.codex`, the router follows you across projects instead of being tied to Babel.

## Usage

Classify a prompt:

```bash
node ./bin/codex-reasoning-router.mjs classify --prompt "fix the flaky CI regression and verify the root cause"
```

Force local heuristic classification for debugging:

```bash
node ./bin/codex-reasoning-router.mjs classify --heuristic --prompt "did you update the readme"
```

Launch Codex with an auto-routed effort:

```bash
node ./bin/codex-reasoning-router.mjs launch --full-auto -- "design an auto reasoning router inside Codex"
```

Dry-run the routed launch:

```bash
node ./bin/codex-reasoning-router.mjs launch --dry-run --full-auto -- "rename this variable"
```

Launch the macOS menubar watcher for the current workspace:

```bash
node ./bin/codex-reasoning-router.mjs menubar --path ./.codex/state/codex-reasoning-router-last-route.json
```

On macOS, the menubar watcher uses two visibility sources:

- hook state files when Codex updates them normally
- a send-time Codex window fallback that listens for Return, OCRs the visible composer box, and classifies the prompt immediately

## Routing policy

The model classifier chooses the smallest sufficient effort:

- `minimal`: direct command-style lookups or tiny mechanical actions.
- `low`: short bounded edits, status checks, rewrites, or straightforward questions.
- `medium`: the default for ordinary coding tasks.
- `high`: multi-step, dependency-aware, verification-heavy work.
- `xhigh`: architecture, migration, security, or other high-impact tasks.

Routing is context-aware, not prompt-only:

- a short follow-up can stay `high` or `xhigh` if the current Codex thread is still in the middle of a refactor, investigation, migration, or other complex work
- the hook path can read recent Codex transcript context from `transcript_path`
- the router also inspects current workspace state such as a dirty git worktree
- the session carryover path can preserve a previous `high` or `xhigh` decision for terse follow-ups until the active thread settles

The fallback heuristic looks at signals like:

- high impact or irreversible changes
- research / verification requirements
- architecture or system design work
- repo-wide or multi-project scope
- deep debugging or performance investigations

## Hook output

The hooks use a small state machine:

1. `UserPromptSubmit` routes the prompt.
2. If the target effort differs from the current config, Codex is told to reply with a one-token precheck only.
3. `PreToolUse` denies Bash commands during that precheck turn.
4. `Stop` rewrites Codex config to the routed effort and automatically replays the original prompt as a new continuation turn.
5. The replay turn runs after the routed config change.
6. The substantive response starts with a visible route banner such as `[auto-route: high]`.
7. `SessionStart` and the next `UserPromptSubmit` restore any lingering routed config back to the previous baseline if a replay left state behind.

The router also writes a trace file to:

- `<cwd>/.codex/state/codex-reasoning-router-last-route.json`
- or `~/.codex/state/...` if no cwd is present

## Release Flow

Versioned release flow:

1. Update code and docs.
2. Run `npm test`.
3. Bump the version with `npm version patch|minor|major`.
4. Push the commit and the generated `v*` tag.
5. GitHub Actions publishes the package to npm with provenance.

The publish workflow lives at `.github/workflows/publish.yml`.

Recommended npm setup:

- Configure npm Trusted Publishing for `francisronge/codex-reasoning-router` on npm.
- No long-lived `NPM_TOKEN` is required.
- The workflow uses GitHub OIDC plus `npm publish --provenance --access public`.

## Install Guide

The short install guide for other Codex users lives in [INSTALL.md](./INSTALL.md).

## Why not automate the desktop UI?

Desktop takeover or GUI scripting is possible in principle, but it is fragile, platform-specific, and easy to make unsafe. This package uses explicit Codex entry points first:

- Codex CLI launch overrides for real effort changes
- Codex hooks for in-app context routing
- No hidden control of the user’s computer or background GUI automation by default

If Codex later exposes a supported hook API for changing effort inline, this package can add that path without changing the router contract.

## References

- [Xuanwo on reasoning effort selection](https://x.com/onlyxuanwo/status/2030220948922937759?s=46)
- [OpenAI prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance)
