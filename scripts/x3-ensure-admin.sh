#!/bin/bash
#
# Ensures an X3 admin account exists after startup
# First oper to register gets olevel 1000.
#
# Flow:
# 1. Delete testadmin from Keycloak if exists (prevents auto-create with olevel 0)
# 2. OPER up and REGISTER directly (first registrant gets olevel 1000)
# 3. Force SAXDB write to persist immediately
#
# IMPORTANT: We do NOT try AUTH first because if the user exists in Keycloak,
# AUTH triggers auto-create which creates the account with olevel 0.
#

IRC_HOST="${IRC_HOST:-nefarious}"
IRC_PORT="${IRC_PORT:-6667}"
OPER_NAME="${OPER_NAME:-oper}"
OPER_PASS="${OPER_PASS:-shmoo}"
X3_ADMIN="${X3_ADMIN:-testadmin}"
X3_ADMIN_PASS="${X3_ADMIN_PASS:-testadmin123}"
X3_ADMIN_EMAIL="${X3_ADMIN_EMAIL:-admin@test.local}"
X3_CONF="${X3_CONF:-/data/x3.conf}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://keycloak:8080}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-testnet}"

echo "Waiting for X3 to be ready..."
sleep 5

# Step 0: Delete testadmin from Keycloak if it exists
# This prevents AUTH from triggering auto-create with olevel 0
echo "Checking for leftover testadmin in Keycloak..."
if command -v curl &> /dev/null; then
  # Get admin token
  KC_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=admin&password=admin&grant_type=password&client_id=admin-cli" 2>/dev/null | \
    grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$KC_TOKEN" ]; then
    # Find testadmin user ID
    TESTADMIN_ID=$(curl -s -H "Authorization: Bearer $KC_TOKEN" \
      "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users?username=$X3_ADMIN&exact=true" 2>/dev/null | \
      grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -n "$TESTADMIN_ID" ]; then
      echo "Found $X3_ADMIN in Keycloak (ID: $TESTADMIN_ID), deleting..."
      curl -s -X DELETE -H "Authorization: Bearer $KC_TOKEN" \
        "$KEYCLOAK_URL/admin/realms/$KEYCLOAK_REALM/users/$TESTADMIN_ID" 2>/dev/null
      echo "Deleted $X3_ADMIN from Keycloak"
    else
      echo "No leftover $X3_ADMIN in Keycloak"
    fi
  else
    echo "Could not get Keycloak token (may not be running), continuing..."
  fi
else
  echo "curl not available, skipping Keycloak cleanup"
fi

# Function to enable email verification inside X3 container (avoids bind mount cache issues)
# Uses docker exec to modify the file directly in X3's filesystem view
# Note: sed -i doesn't work on bind mounts, so we use temp file + cat (not cp, which fails)
# Run as root (-u 0) to have write permission on the bind-mounted file
enable_email_in_x3() {
  echo "Enabling email verification in X3 container..."
  docker exec -u 0 x3 sh -c 'sed "s/\"email_enabled\" \"0\"/\"email_enabled\" \"1\"/" /x3/x3.conf > /tmp/x3.conf.new && cat /tmp/x3.conf.new > /x3/x3.conf && rm /tmp/x3.conf.new'
}

# Note: X3 must START with email_enabled=0 in x3.conf
# We can't disable email before registration because no one has olevel to REHASH yet.
# After admin is created with olevel 1000, we enable email and REHASH.

echo "Checking/creating admin account..."

# Create FIFOs for bidirectional communication
FIFO_IN=/tmp/irc_in_$$
FIFO_OUT=/tmp/irc_out_$$
mkfifo "$FIFO_IN" "$FIFO_OUT"
trap "rm -f $FIFO_IN $FIFO_OUT" EXIT

# Start netcat with FIFOs
nc "$IRC_HOST" "$IRC_PORT" < "$FIFO_IN" > "$FIFO_OUT" &
NC_PID=$!

# Open FIFOs
exec 3>"$FIFO_IN"
exec 4<"$FIFO_OUT"

send() {
  printf "%s\r\n" "$1" >&3
}

# Register with server
send "NICK adminbot$$"
send "USER bot bot bot :Admin Bot"

# Read and handle PING, wait for 001
registered=0
timeout=30
while [ $timeout -gt 0 ] && [ $registered -eq 0 ]; do
  if read -t 1 line <&4; then
    echo "$line"
    echo "$line" >> /tmp/irc.log

    # Handle PING
    case "$line" in
      PING*)
        pong=$(echo "$line" | sed 's/PING/PONG/')
        send "$pong"
        ;;
      *" 001 "*)
        registered=1
        ;;
    esac
  fi
  timeout=$((timeout - 1))
done

if [ $registered -eq 0 ]; then
  echo "Failed to register with IRC server"
  kill $NC_PID 2>/dev/null
  exit 1
fi

echo "Registered with server, continuing..."

# Read remaining welcome messages
sleep 1
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# NOTE: We skip AUTH and go straight to REGISTER
# If account already exists in X3, REGISTER will fail with "already registered"
# which is fine - it means it was the first registrant and has olevel 1000

echo ""
echo "Attempting to register admin account..."

# Oper up first
send "OPER $OPER_NAME $OPER_PASS"
sleep 1
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Register the account (email verification should be disabled in x3.conf at startup)
echo "Registering admin account..."
send "PRIVMSG AuthServ :REGISTER $X3_ADMIN $X3_ADMIN_PASS $X3_ADMIN_EMAIL"
sleep 3
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Now AUTH with the newly registered account to get olevel 1000
echo "Authenticating with new account..."
send "PRIVMSG AuthServ :AUTH $X3_ADMIN $X3_ADMIN_PASS"
sleep 2
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Force SAXDB write to persist the new account immediately
# (First registered account gets olevel 1000, must be persisted before restart)
echo "Forcing SAXDB write..."
send "PRIVMSG O3 :WRITEALL"
sleep 2
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Enable email verification for regular users (using docker exec to avoid bind mount cache issues)
enable_email_in_x3

# Send REHASH to apply email verification setting
echo "Sending REHASH to enable email verification..."
send "PRIVMSG O3 :REHASH"
sleep 2
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

send "QUIT"
sleep 1
kill $NC_PID 2>/dev/null

echo ""
echo "--- Checking results ---"

if grep -q "Account has been registered" /tmp/irc.log; then
  echo "SUCCESS: Admin account '$X3_ADMIN' created with olevel 1000."
  echo ""
  echo "For cleanup: X3_ACCOUNT=$X3_ADMIN X3_PASSWORD=$X3_ADMIN_PASS npm run cleanup"
  exit 0
fi

if grep -q "already registered" /tmp/irc.log; then
  echo "Account '$X3_ADMIN' already exists (may need activation)."
  exit 0
fi

echo "Could not verify. Check output above."
exit 1
