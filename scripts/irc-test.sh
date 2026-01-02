#!/bin/bash
#
# Simple IRC test client for quick tests
# Usage: ./irc-test.sh [commands...]
#
# Examples:
#   ./irc-test.sh "PRIVMSG AuthServ :AUTH user pass"
#   ./irc-test.sh "JOIN #test" "PRIVMSG #test :Hello"
#   echo "PRIVMSG ChanServ :INFO #test" | ./irc-test.sh
#
# Environment:
#   IRC_HOST (default: localhost)
#   IRC_PORT (default: 6667)
#   IRC_NICK (default: testbot$$)
#   IRC_OPER (default: empty - don't oper)
#   IRC_OPER_PASS (default: shmoo)
#   IRC_AUTH (default: empty - don't auth)
#   IRC_AUTH_PASS (default: empty)
#   IRC_WAIT (default: 2 - seconds to wait after each command)
#

IRC_HOST="${IRC_HOST:-localhost}"
IRC_PORT="${IRC_PORT:-6667}"
IRC_NICK="${IRC_NICK:-testbot$$}"
IRC_OPER="${IRC_OPER:-}"
IRC_OPER_PASS="${IRC_OPER_PASS:-shmoo}"
IRC_AUTH="${IRC_AUTH:-}"
IRC_AUTH_PASS="${IRC_AUTH_PASS:-}"
IRC_WAIT="${IRC_WAIT:-2}"

# Create FIFOs
FIFO_IN=/tmp/irc_in_$$
FIFO_OUT=/tmp/irc_out_$$
mkfifo "$FIFO_IN" "$FIFO_OUT"
trap "rm -f $FIFO_IN $FIFO_OUT; kill $NC_PID 2>/dev/null" EXIT

# Start netcat
nc "$IRC_HOST" "$IRC_PORT" < "$FIFO_IN" > "$FIFO_OUT" &
NC_PID=$!

# Open FIFOs
exec 3>"$FIFO_IN"
exec 4<"$FIFO_OUT"

send() {
  printf "%s\r\n" "$1" >&3
  [ -n "$DEBUG" ] && echo ">>> $1" >&2
}

# Register
send "NICK $IRC_NICK"
send "USER testbot testbot testbot :Test Bot"

# Wait for registration (handle PING)
registered=0
timeout=30
while [ $timeout -gt 0 ] && [ $registered -eq 0 ]; do
  if read -t 1 line <&4 2>/dev/null; then
    echo "$line"
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

[ $registered -eq 0 ] && { echo "Failed to register"; exit 1; }

# Drain remaining welcome messages
while read -t 1 line <&4 2>/dev/null; do
  echo "$line"
  case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
done

# Oper up if requested
if [ -n "$IRC_OPER" ]; then
  send "OPER $IRC_OPER $IRC_OPER_PASS"
  sleep 1
  while read -t 1 line <&4 2>/dev/null; do
    echo "$line"
    case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
  done
fi

# Auth if requested
if [ -n "$IRC_AUTH" ]; then
  send "PRIVMSG AuthServ :AUTH $IRC_AUTH $IRC_AUTH_PASS"
  sleep 1
  while read -t 1 line <&4 2>/dev/null; do
    echo "$line"
    case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
  done
fi

# Process commands from args
for cmd in "$@"; do
  send "$cmd"
  sleep "$IRC_WAIT"
  while read -t 1 line <&4 2>/dev/null; do
    echo "$line"
    case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
  done
done

# Process commands from stdin if not a tty
if [ ! -t 0 ]; then
  while read cmd; do
    send "$cmd"
    sleep "$IRC_WAIT"
    while read -t 1 line <&4 2>/dev/null; do
      echo "$line"
      case "$line" in PING*) send "$(echo "$line" | sed 's/PING/PONG/')";; esac
    done
  done
fi

send "QUIT"
sleep 1
