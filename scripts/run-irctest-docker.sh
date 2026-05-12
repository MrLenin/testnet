#!/bin/bash
# Run irctest conformance tests against the fresh nefarious build by
# launching a one-shot container based on the testnet-nefarious image.
# The image already has ircd + all runtime libs; we install python +
# pytest + irctest's deps on the fly inside the throwaway container.
#
# Usage:
#   ./scripts/run-irctest-docker.sh                 # all (filtered) tests
#   ./scripts/run-irctest-docker.sh -k test_echo    # specific tests
#   ./scripts/run-irctest-docker.sh -x              # stop on first failure
#
# Notes:
#   - Doesn't touch the running nefarious container; the irctest harness
#     spawns its own ircd subprocesses inside the throwaway container.
#   - Marker filter matches scripts/run-irctest.sh: skips services,
#     implementation-specific, deprecated, strict.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTNET_DIR="$(dirname "$SCRIPT_DIR")"
IRCTEST_REPO="https://github.com/MrLenin/irctest.git"
IRCTEST_DIR="${TESTNET_DIR}/.irctest"

# Clone or refresh irctest checkout on the host so the container sees
# the latest controller patches.
if [ ! -d "$IRCTEST_DIR" ]; then
    echo "Cloning irctest..."
    git clone "$IRCTEST_REPO" "$IRCTEST_DIR"
else
    echo "Updating irctest..."
    git -C "$IRCTEST_DIR" pull --ff-only 2>/dev/null || true
fi

# Verify the testnet-nefarious image is present (built by the main
# docker compose flow).
if ! docker image inspect testnet-nefarious >/dev/null 2>&1; then
    echo "Error: testnet-nefarious image missing.  Run dcl --build first."
    exit 1
fi

echo "Running irctest inside testnet-nefarious container..."

# Mount the irctest checkout writable (pytest writes __pycache__) and
# the project-local controller override read-only.  Run as root so apt
# / pip have permissions; the throwaway container is discarded on exit.
# Setup phase runs as root (apt + venv install), then we drop to the
# nefarious user before invoking pytest.  ircd hard-refuses to run as
# root, so the test subprocess MUST come up as nefarious.
docker run --rm -i \
    -v "$IRCTEST_DIR:/irctest" \
    -v "$TESTNET_DIR/irctest:/local-irctest:ro" \
    -w /irctest \
    --user root \
    --entrypoint /bin/bash \
    testnet-nefarious -c "
        set -e
        export DEBIAN_FRONTEND=noninteractive
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends python3-pip python3-venv su-exec >/dev/null 2>&1 \\
            || apt-get install -y --no-install-recommends python3-pip python3-venv >/dev/null
        python3 -m venv /tmp/venv
        . /tmp/venv/bin/activate
        pip install --quiet -r requirements.txt pytest-xdist pytest-timeout
        # The repo ships a nefarious controller override that exercises
        # IRCv3 caps; the upstream stub doesn't.  Drop it in place.
        cp /local-irctest/nefarious.py irctest/controllers/nefarious.py
        # nefarious owns the venv + cwd so the pytest user can write
        # __pycache__ and bind listener ports.
        chown -R nefarious:nefarious /tmp/venv /irctest
        # Drop privileges via setpriv (always present on Debian).
        exec setpriv --reuid nefarious --regid nefarious --clear-groups \\
            bash -c '
                . /tmp/venv/bin/activate
                export PATH=/home/nefarious/bin:\$PATH
                export IRCTEST_DEBUG_LOGS=1
                python -m pytest \\
                    --controller=irctest.controllers.nefarious \\
                    -m \"not services and not implementation-specific and not deprecated and not strict\" \\
                    --timeout=300 \\
                    -n 4 \\
                    -v \\
                    $*
            '
    "
