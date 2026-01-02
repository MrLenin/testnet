#!/bin/bash
#
# Ensures an X3 admin account exists after startup
# First oper to register gets olevel 1000.
#
# Flow:
# 1. Try to auth with existing account
# 2. If account doesn't exist:
#    a. Disable email verification in x3.conf
#    b. Send REHASH to X3
#    c. Register the account
#    d. Restore email verification
#    e. Send REHASH again
#

IRC_HOST="${IRC_HOST:-nefarious}"
IRC_PORT="${IRC_PORT:-6667}"
OPER_NAME="${OPER_NAME:-oper}"
OPER_PASS="${OPER_PASS:-shmoo}"
X3_ADMIN="${X3_ADMIN:-testadmin}"
X3_ADMIN_PASS="${X3_ADMIN_PASS:-testadmin123}"
X3_ADMIN_EMAIL="${X3_ADMIN_EMAIL:-admin@test.local}"
X3_CONF="${X3_CONF:-/data/x3.conf}"

echo "Waiting for X3 to be ready..."
sleep 5

# Function to disable email verification
disable_email() {
  if [ -f "$X3_CONF" ]; then
    echo "Disabling email verification..."
    sed -i 's/"email_enabled" "1"/"email_enabled" "0"/' "$X3_CONF"
  fi
}

# Function to restore email verification
restore_email() {
  if [ -f "$X3_CONF" ]; then
    echo "Restoring email verification..."
    sed -i 's/"email_enabled" "0"/"email_enabled" "1"/' "$X3_CONF"
  fi
}

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

# Try to auth first - if it works, account already exists
send "PRIVMSG AuthServ :AUTH $X3_ADMIN $X3_ADMIN_PASS"
sleep 2
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Check if auth succeeded
if grep -q "I recognize you" /tmp/irc.log; then
  echo ""
  echo "--- Account already exists ---"
  echo "SUCCESS: Admin account '$X3_ADMIN' already exists and is activated."
  send "QUIT"
  sleep 1
  kill $NC_PID 2>/dev/null
  exit 0
fi

echo ""
echo "Account doesn't exist, creating..."

# Oper up first
send "OPER $OPER_NAME $OPER_PASS"
sleep 1
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Disable email verification
disable_email

# Send REHASH to O3 to reload config
echo "Sending REHASH to reload config..."
send "PRIVMSG O3 :REHASH"
sleep 3
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Register the account (now without email verification)
echo "Registering admin account..."
send "PRIVMSG AuthServ :REGISTER $X3_ADMIN $X3_ADMIN_PASS $X3_ADMIN_EMAIL"
sleep 3
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  echo "$line" >> /tmp/irc.log
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Restore email verification
restore_email

# Send REHASH again to restore original config
echo "Sending REHASH to restore config..."
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
