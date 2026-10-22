#!/usr/bin/env python3
"""A client that registers, then stops reading -- its server's sendQ for it
fills until the server gives up on the socket ("Max sendQ exceeded").

Usage: stall_reader.py HOST PORT RCVBUF NICK REALNAME CHANNEL[,CHANNEL...] [ACCOUNT PASSWORD]

With ACCOUNT/PASSWORD it logs in with SASL PLAIN and turns bouncer hold on.
Prints "READY <nick>" once joined (the nick the server gave it), then reads
nothing more and exits when stdin closes (the test owns its lifetime).
SO_RCVBUF is set before connect, so the TCP window stays small.
"""
import base64
import socket
import sys

host, port, rcvbuf, nick, realname, channel = sys.argv[1:7]
account = sys.argv[7] if len(sys.argv) > 8 else None
password = sys.argv[8] if len(sys.argv) > 8 else None

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, int(rcvbuf))
s.connect((host, int(port)))
s.settimeout(30)
buf = b""


def send(line):
    s.sendall((line + "\r\n").encode())


def until(pred):
    global buf
    while True:
        while b"\r\n" in buf:
            raw, buf = buf.split(b"\r\n", 1)
            line = raw.decode(errors="replace")
            if line.startswith("PING"):
                send("PONG" + line[4:])
                continue
            if pred(line):
                return line
        data = s.recv(65536)
        if not data:
            raise SystemExit("closed before ready")
        buf += data


if account:
    send("CAP REQ :sasl")
send(f"NICK {nick}")
send(f"USER {nick} 0 * :{realname}")
if account:
    until(lambda l: " CAP " in l and " ACK " in l)
    send("AUTHENTICATE PLAIN")
    until(lambda l: l.startswith("AUTHENTICATE"))
    send("AUTHENTICATE " + base64.b64encode(f"{account}\0{account}\0{password}".encode()).decode())
    until(lambda l: " 903 " in l or " 904 " in l)
    send("CAP END")
welcome = until(lambda l: " 001 " in l)
nick = welcome.split()[2]
until(lambda l: " 376 " in l or " 422 " in l)
if account:
    send("BOUNCER SET HOLD on")
send(f"JOIN {channel}")
last = channel.split(",")[-1]
until(lambda l: " 366 " in l and f" {last} " in l)
print(f"READY {nick}", flush=True)

# From here on: read nothing.  Wait for the test to close stdin.
sys.stdin.read()
s.close()
