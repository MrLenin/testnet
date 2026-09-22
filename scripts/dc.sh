#!/usr/bin/env bash
# Mirror of the user's `dc` / `dcl` bashrc functions.  Sourcing .env and
# .env.local with auto-export is essential — docker-compose.yml relies
# on those values (IRC_HOST, X3_ADMIN, etc.), and without them container
# init paths fail in confusing ways (cf. CLAUDE.md "do NOT run docker
# compose build" — root cause is .env.local being skipped).
#
# Usage:
#   scripts/dc.sh up -d                      # base topology
#   scripts/dc.sh -l up -d                   # + nefarious2   (--profile linked)
#   scripts/dc.sh -l --profile multi up -d   # + nefarious3/4 (linked + multi)
#   scripts/dc.sh logs nefarious
#
# -l / --linked adds `--profile linked`, which is the only thing that brings
# nefarious2 into scope.  Without it, `up -d` never creates or recreates
# nefarious2 -- a rebuilt nefarious2 image then sits unused while the old
# container keeps running.
#
# History: -l used to mean "add the libkc-dev compose overlay" (mirroring the
# dcl bashrc function).  a7245017 retired that overlay with libkc and left the
# flag parsed but inert, so from 2026-07-27 `dc.sh -l up -d` silently did
# nothing extra -- while CLAUDE.md documented it as adding nefarious2.

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

# BuildKit collapses successful build output by default, so compiler warnings
# scroll past unreachably.  When a build is happening this turn (either a
# bare `build` subcommand or `--build` passed to `up`), switch to plain
# progress so the full log stays on screen and can be piped/teed.
for arg in "$@"; do
  if [[ "$arg" == "build" || "$arg" == "--build" ]]; then
    export BUILDKIT_PROGRESS=plain
    break
  fi
done

if [[ $LINKED -eq 1 ]]; then
  set -- --profile linked "$@"
fi

exec docker compose "$@"
