#!/bin/bash
# Wrapper script for docker compose that loads both .env and .env.local
# Usage: ./start.sh up -d
#        ./start.sh logs -f nefarious
#        ./start.sh down

set -a  # Export all variables

# Load base environment
source "$(dirname "$0")/.env"

# Load local overrides if present
if [ -f "$(dirname "$0")/.env.local" ]; then
    source "$(dirname "$0")/.env.local"
fi

set +a  # Stop exporting

# Pass all arguments to docker compose
exec docker compose "$@"
