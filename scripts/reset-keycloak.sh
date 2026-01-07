#!/bin/bash
# Reset Keycloak database in PostgreSQL
# This drops and recreates the db_keycloak database for a clean slate

set -e

# PostgreSQL connection via Consul DNS (requires dns-resolver running)
# Or override with environment variables
PGHOST="${PGHOST:-master.postgresql.service.consul}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-keycloak}"
PGPASSWORD="${PGPASSWORD:-${KC_DB_PASSWORD:-changeme}}"
PGDATABASE="db_keycloak"

echo "=== Keycloak Database Reset ==="
echo "Host: $PGHOST:$PGPORT"
echo "Database: $PGDATABASE"
echo ""

# Check if we're running from within Docker network (can resolve Consul)
if ! host "$PGHOST" >/dev/null 2>&1; then
    echo "ERROR: Cannot resolve $PGHOST"
    echo "Run this script from within the Docker network, or set PGHOST to the PostgreSQL IP"
    echo ""
    echo "Option 1: Run via docker compose exec"
    echo "  docker compose exec dns-resolver sh -c 'apk add postgresql-client && /scripts/reset-keycloak.sh'"
    echo ""
    echo "Option 2: Set PGHOST to current master IP"
    echo "  PGHOST=<ip> $0"
    exit 1
fi

echo "Stopping Keycloak..."
docker compose stop keycloak keycloak-setup 2>/dev/null || true

echo ""
echo "Terminating existing connections..."
PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PGDATABASE' AND pid <> pg_backend_pid();"

echo "Dropping database..."
PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "DROP DATABASE IF EXISTS $PGDATABASE;"

echo "Creating database..."
PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "CREATE DATABASE $PGDATABASE OWNER $PGUSER;"

echo ""
echo "Database reset complete."
echo ""
echo "Starting Keycloak..."
docker compose up -d keycloak

echo ""
echo "Waiting for Keycloak to be healthy..."
timeout 120 sh -c 'until docker compose exec keycloak sh -c "exec 3<>/dev/tcp/127.0.0.1/8080" 2>/dev/null; do sleep 2; done' || {
    echo "WARNING: Keycloak health check timed out. Check logs with: docker compose logs keycloak"
}

echo ""
echo "Running Keycloak setup..."
docker compose up keycloak-setup

echo ""
echo "=== Reset Complete ==="
echo "Keycloak is ready with a fresh database."
echo "Admin console: http://localhost:8080/admin (admin/admin)"
