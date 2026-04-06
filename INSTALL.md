# Install Guide

`codex-reasoning-router` is designed to be installed once on a machine and then help across all Codex projects.

## Local checkout

```bash
git clone https://github.com/francisronge/codex-reasoning-router.git
cd codex-reasoning-router
bash ./scripts/bootstrap-local.sh
```

## What bootstrap does

1. Runs `npm link` so `codex-reasoning-router` is available from your shell.
2. Installs the router hooks into `~/.codex/hooks.json`.
3. Ensures Codex hook support is enabled in `~/.codex/config.toml`.
4. Enables model-routed prompt classification with a visible route banner in Codex responses.

## Use it across projects

Once installed globally, the router works in Babel and any other repo you open with Codex on this machine.

Default behavior:

- Codex classifies the prompt before substantive work starts.
- The router picks `low`, `medium`, `high`, or `xhigh`.
- The router can consider the exact active-session transcript binding, prior routed effort, and current workspace state instead of treating the latest prompt in isolation.
- The first real response shows the chosen effort as `[auto-route: ...]`.
- On macOS, you can launch a menubar watcher that shows the latest route persistently.
- If Codex desktop does not refresh the hook files in time, the watcher also has a send-time fallback that listens for Return, OCRs the visible composer, and classifies the prompt from the window itself using the router's last exact session binding for that workspace.

Launch the watcher:

```bash
codex-reasoning-router menubar --path ./.codex/state/codex-reasoning-router-last-route.json
```

To turn CRR completely off, disable its hooks:

```bash
codex-reasoning-router control disable --scope global
```

That removes CRR from `~/.codex/hooks.json`, so Codex stops showing its hook lifecycle rows. Re-enable with:

```bash
codex-reasoning-router control enable --scope global
```

Optional shell alias:

```bash
alias codex-auto='codex-reasoning-router launch'
```

Examples:

```bash
codex-auto --full-auto -- "debug the flaky CI regression"
codex-auto --full-auto -- "rename this variable"
```

## Update

```bash
git pull
bash ./scripts/bootstrap-local.sh
```

## Publish releases

This repo is set up for npm Trusted Publishing from GitHub Actions.

1. Create the `codex-reasoning-router` package on npm if it does not exist yet.
2. In npm package settings, add `francisronge/codex-reasoning-router` as a Trusted Publisher for GitHub Actions.
3. Release by tagging a version:

```bash
npm version patch
git push
git push --tags
```

No long-lived `NPM_TOKEN` is required for the GitHub workflow.

## Remove

```bash
npm unlink -g codex-reasoning-router
```

Then remove the router entries from `~/.codex/hooks.json` if you no longer want Codex-wide routing.
