#!/usr/bin/env bash
# Run Maven for keycloak-webhook-spi in a throwaway container.
# Source is mounted read-only at /src and copied to /build, so nothing is written
# into the worktree; the download cache lives in the named volume spi-it-m2.
# Usage: scripts/spi-mvn.sh <mvn arguments>     e.g. scripts/spi-mvn.sh -q test
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm \
  -v "$REPO_ROOT/keycloak-webhook-spi:/src:ro" \
  -v spi-it-m2:/root/.m2 \
  maven:3.9-eclipse-temurin-17 \
  sh -c 'cp -r /src /build && cd /build && exec mvn "$@"' mvn "$@"
