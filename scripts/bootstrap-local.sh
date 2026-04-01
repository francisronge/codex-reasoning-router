#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "[codex-reasoning-router] linking package from ${REPO_ROOT}"
npm link

echo "[codex-reasoning-router] installing global Codex hooks"
codex-reasoning-router install --scope global

echo "[codex-reasoning-router] done"
echo "Optional alias: alias codex-auto='codex-reasoning-router launch'"
