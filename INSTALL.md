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

## Use it across projects

Once installed globally, the router works in Babel and any other repo you open with Codex on this machine.

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

## Remove

```bash
npm unlink -g codex-reasoning-router
```

Then remove the router entries from `~/.codex/hooks.json` if you no longer want Codex-wide routing.
