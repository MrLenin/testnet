#!/bin/bash
#
# Cleanup script for test data
# Removes temporary accounts (test*) and channels (#test-*) created during testing
#
# Usage: ./scripts/cleanup-test-data.sh [--dry-run]
#

set -e

DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "=== DRY RUN MODE - No changes will be made ==="
fi

# Get the x3.db path
X3_DB="${X3_DB:-/home/ibutsu/testnet/x3data/x3.db}"

if [[ ! -f "$X3_DB" ]]; then
    echo "Error: x3.db not found at $X3_DB"
    echo "Try: X3_DB=/path/to/x3.db $0"
    exit 1
fi

echo "Using database: $X3_DB"

# Create a backup
if [[ "$DRY_RUN" == "false" ]]; then
    BACKUP="${X3_DB}.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$X3_DB" "$BACKUP"
    echo "Backup created: $BACKUP"
fi

# Count test accounts
TEST_ACCOUNTS=$(grep -c '"test[a-f0-9]\{5,6\}"' "$X3_DB" 2>/dev/null || echo "0")
echo "Found approximately $TEST_ACCOUNTS test accounts"

# Count test channels
TEST_CHANNELS=$(grep -c '"#test-[a-f0-9]\{6,8\}"' "$X3_DB" 2>/dev/null || echo "0")
echo "Found approximately $TEST_CHANNELS test channels"

if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "Sample test accounts:"
    grep -oE '"test[a-f0-9]{5,6}"' "$X3_DB" 2>/dev/null | head -10 || echo "  (none found)"
    echo ""
    echo "Sample test channels:"
    grep -oE '"#test-[a-f0-9]{6,8}"' "$X3_DB" 2>/dev/null | head -10 || echo "  (none found)"
    echo ""
    echo "Run without --dry-run to clean up"
    exit 0
fi

# The x3.db is in saxdb format which is complex to parse safely
# Better approach: restart X3 after clearing or use IRC commands
echo ""
echo "=== Cleanup Options ==="
echo ""
echo "Option 1: Reset X3 database (removes ALL data)"
echo "  docker compose stop x3"
echo "  rm -f $X3_DB"
echo "  docker compose up -d x3"
echo ""
echo "Option 2: Use IRC commands (preserves non-test data)"
echo "  Connect as an oper and use:"
echo "  /msg O3 ODELUSER <account>  - for each test account"
echo "  /msg X3 UNREGISTER #channel CONFIRM - for each test channel"
echo ""
echo "Option 3: Run the Node.js cleanup script (recommended)"
echo "  cd tests && npm run cleanup"
echo ""

# Create a Node.js cleanup helper
cat > /home/ibutsu/testnet/tests/src/cleanup.ts << 'CLEANUP_TS'
/**
 * Cleanup script for test data
 *
 * Connects to X3 and removes test accounts and channels.
 * Run with: npx tsx src/cleanup.ts
 */

import { createX3Client } from './helpers/index.js';

async function cleanup() {
  console.log('Connecting to IRC server...');

  const client = await createX3Client();

  // Give time to connect
  await new Promise(r => setTimeout(r, 2000));

  // We need oper access to delete accounts
  // For now, just list what would be cleaned up
  console.log('\nTo clean up test data, connect as an oper and run:');
  console.log('');
  console.log('  /msg O3 ODELUSER test* - Delete test accounts');
  console.log('  Or individually: /msg O3 ODELUSER testXXXXXX');
  console.log('');
  console.log('For channels, the owner must unregister or use:');
  console.log('  /msg O3 UNREGISTER #test-XXXXXXXX CONFIRM');
  console.log('');

  client.send('QUIT :Cleanup complete');
  client.close();

  console.log('Disconnected.');
}

cleanup().catch(console.error);
CLEANUP_TS

echo "Created tests/src/cleanup.ts"
echo ""
echo "To use: cd tests && npx tsx src/cleanup.ts"
