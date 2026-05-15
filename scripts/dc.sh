#!/usr/bin/env bash
# Mirror of the user's `dc` / `dcl` bashrc functions.  Sourcing .env and
# .env.local with auto-export is essential — docker-compose.yml relies
# on those values (IRC_HOST, X3_ADMIN, etc.), and without them container
# init paths fail in confusing ways (cf. CLAUDE.md "do NOT run docker
# compose build" — root cause is .env.local being skipped).
#
# Usage:
#   scripts/dc.sh up -d nefarious2
#   scripts/dc.sh --profile linked up -d nefarious2
#   scripts/dc.sh logs nefarious
#
# The "linked" wrapper (parallel to dcl) is selected via -l / --linked
# before the docker compose args:
#   scripts/dc.sh -l up -d --build
#
# -l adds the libkc-dev overlay via COMPOSE_FILE so local/libkc:dev
# resolves correctly on `--build`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LINKED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -l|--linked)
      LINKED=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

if [[ $LINKED -eq 1 ]]; then
  export COMPOSE_FILE="docker-compose.yml:docker-compose.libkc-dev.yml"
fi

exec docker compose "$@"
