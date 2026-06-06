#!/usr/bin/env bash
# Fast CRDT-engine test loop (CRDT-mesh Phase 0).
# Builds the lightweight test image and runs the CMocka suite.
# Build artifacts stay in the image; the source tree is never tainted.
#
# Usage: tests/crdt/run.sh        (from the testnet repo root)
set -euo pipefail

cd "$(dirname "$0")/../.."   # testnet repo root

echo "==> building crdt-test image (compile = link-time TDD red/green)"
docker build -f tests/crdt/Dockerfile -t crdt-test ./nefarious-crdt

echo "==> running CRDT CMocka suite"
docker run --rm crdt-test
