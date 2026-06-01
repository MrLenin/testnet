#!/bin/bash
# Run irctest conformance tests against nefarious (host execution).
#
# Usage:
#   ./scripts/run-irctest.sh                    # run all (filtered) tests
#   ./scripts/run-irctest.sh -k test_echo       # run specific tests
#   ./scripts/run-irctest.sh -x                 # stop on first failure
#
# Prerequisites:
#   - ircd binary on PATH or built locally (nefarious/ircd/ircd)
#   - python3 + venv (pip installs deps into .irctest-venv on first run)
#   - faketime (optional, for time-dependent tests)
#
# Layout (post-reorg):
#   - nefarious/.irctest/                       irctest fork (submodule of nefarious, evilnet/irctest)
#   - nefarious/tools/irctest/nefarious.py      our IRCv3-aware BaseServerController override
#   - .irctest-venv/                            Python venv (host-local, recreated as needed)
#
# Why a tmp checkout?  Both the host and docker variants need to overlay
# our controller onto irctest's module tree (`irctest/controllers/
# nefarious.py`).  Writing it directly into the submodule would dirty
# the submodule's working tree on every run.  Instead we `cp -a` the
# submodule contents to a tmp dir, apply the overlay there, and run
# from the tmp dir — submodule stays bit-clean.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTNET_DIR="$(dirname "$SCRIPT_DIR")"
IRCTEST_SRC="${TESTNET_DIR}/nefarious/.irctest"
NEFARIOUS_CONTROLLER="${TESTNET_DIR}/nefarious/tools/irctest/nefarious.py"
VENV_DIR="${TESTNET_DIR}/.irctest-venv"

# Ensure the irctest submodule is initialised.
if [ ! -f "${IRCTEST_SRC}/requirements.txt" ]; then
    echo "Initialising irctest submodule inside nefarious/..."
    git -C "${TESTNET_DIR}/nefarious" submodule update --init .irctest
fi

# Set up host venv on first run.
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating venv..."
    python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Stage a clean copy of the fork in a tmp dir so the overlay doesn't
# dirty the submodule working tree.
IRCTEST_TMP="$(mktemp -d -t irctest-run-XXXXXX)"
trap 'rm -rf "$IRCTEST_TMP"' EXIT
cp -a "${IRCTEST_SRC}/." "$IRCTEST_TMP/"
cp "$NEFARIOUS_CONTROLLER" "$IRCTEST_TMP/irctest/controllers/nefarious.py"

cd "$IRCTEST_TMP"
pip install -q -r requirements.txt pytest-xdist pytest-timeout 2>/dev/null || true

# Find ircd binary.
IRCD_BIN=$(which ircd 2>/dev/null || true)
if [ -z "$IRCD_BIN" ]; then
    for candidate in \
        "$HOME/.local/bin/ircd" \
        "$HOME/bin/ircd" \
        "$TESTNET_DIR/nefarious/ircd/ircd"; do
        if [ -x "$candidate" ]; then
            IRCD_BIN="$candidate"
            break
        fi
    done
fi

if [ -z "$IRCD_BIN" ] || [ ! -x "$IRCD_BIN" ]; then
    echo "Error: ircd binary not found."
    echo ""
    echo "Build nefarious first:"
    echo "  cd nefarious"
    echo "  ./configure --prefix=\$HOME/.local --enable-debug --with-maxcon=4096 \\"
    echo "              --with-rocksdb=/usr --with-zstd=/usr --enable-keycloak"
    echo "  make -j\$(nproc)"
    echo "  echo -e 'N\\n\\n\\n\\n\\n\\n\\n\\n' | make install"
    exit 1
fi

echo "Using ircd: $IRCD_BIN"
echo "Running irctest..."
echo ""

PATH="$(dirname "$IRCD_BIN"):$PATH" \
LD_LIBRARY_PATH="${HOME}/.local/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
IRCTEST_DEBUG_LOGS=1 \
python -m pytest \
    --controller=irctest.controllers.nefarious \
    -m 'not services and not implementation-specific and not deprecated and not strict' \
    --timeout=300 \
    -n 4 \
    -v \
    "$@"
