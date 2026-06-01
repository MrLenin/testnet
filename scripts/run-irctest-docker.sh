#!/bin/bash
# Run irctest conformance tests against the fresh nefarious build inside
# a throwaway container based on the testnet-nefarious image.  The image
# has ircd + runtime libs; we install python + pytest + irctest deps on
# the fly inside the throwaway container.
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
#
# Layout (post-reorg):
#   - nefarious/.irctest/                       irctest fork (submodule of nefarious, evilnet/irctest)
#   - nefarious/tools/irctest/nefarious.py      our IRCv3-aware controller override
#
# We stage a clean copy of the fork in a host tmp dir, drop our
# controller on top, then bind-mount the tmp dir into the container.
# The submodule's working tree is never written through the mount.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTNET_DIR="$(dirname "$SCRIPT_DIR")"
IRCTEST_SRC="${TESTNET_DIR}/nefarious/.irctest"
NEFARIOUS_CONTROLLER="${TESTNET_DIR}/nefarious/tools/irctest/nefarious.py"

# Ensure the irctest submodule is checked out on the host.
if [ ! -f "${IRCTEST_SRC}/requirements.txt" ]; then
    echo "Initialising irctest submodule inside nefarious/..."
    git -C "${TESTNET_DIR}/nefarious" submodule update --init .irctest
fi

# Verify the testnet-nefarious image is present.
if ! docker image inspect testnet-nefarious >/dev/null 2>&1; then
    echo "Error: testnet-nefarious image missing.  Run dcl --build first."
    exit 1
fi

# Stage a clean tmp copy with the controller overlay applied, so the
# container's bind-mount points at an already-overlayed tree and the
# submodule working tree never gets written.
IRCTEST_TMP="$(mktemp -d -t irctest-run-XXXXXX)"
trap 'rm -rf "$IRCTEST_TMP"' EXIT
cp -a "${IRCTEST_SRC}/." "$IRCTEST_TMP/"
cp "$NEFARIOUS_CONTROLLER" "$IRCTEST_TMP/irctest/controllers/nefarious.py"

echo "Running irctest inside testnet-nefarious container..."

# Setup phase runs as root (apt + venv install); then we drop to the
# nefarious user before invoking pytest.  ircd hard-refuses to run as
# root, so the test subprocess MUST come up as nefarious.
docker run --rm -i \
    -v "$IRCTEST_TMP:/irctest" \
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
        # The tmp dir already has our controller overlay applied on the
        # host before the bind-mount, so no in-container cp is needed.
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
                    \\
                    \\
                    -v \\
                    $*
            '
    "
