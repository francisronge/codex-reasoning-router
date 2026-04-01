# codex-reasoning-router

`codex-reasoning-router` is a standalone helper for Codex that classifies task shape and routes reasoning effort before work starts.

It is built around two realities:

1. The OpenAI prompt guidance recommends choosing reasoning effort based on task shape, not just always using the highest setting.
2. Current Codex hooks can add context on `UserPromptSubmit`, and `Stop` can automatically create a continuation turn.

Because of that, the tool ships two complementary paths:

- `launch`: the real pre-run router. It chooses an effort level, then starts Codex with `-c model_reasoning_effort=...`.
- `hook`: the always-on in-Codex router. It uses a light preflight turn plus a `Stop` replay turn to retarget reasoning before substantive work starts.

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

Launch Codex with an auto-routed effort:

```bash
node ./bin/codex-reasoning-router.mjs launch --full-auto -- "design an auto reasoning router inside Codex"
```

Dry-run the routed launch:

```bash
node ./bin/codex-reasoning-router.mjs launch --dry-run --full-auto -- "rename this variable"
```

## Routing policy

The router is intentionally deterministic and cheap:

- `minimal`: direct command-style lookups or tiny mechanical actions.
- `low`: simple bounded edits, rewrites, or questions.
- `medium`: the default for ordinary coding tasks.
- `high`: multi-step, dependency-aware, verification-heavy work.
- `xhigh`: architecture, migration, security, or other high-impact tasks.

The classifier uses weighted signals like:

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
6. `SessionStart` and the next `UserPromptSubmit` restore any lingering routed config back to the previous baseline if a replay left state behind.

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
