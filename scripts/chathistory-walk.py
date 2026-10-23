#!/usr/bin/env python3
"""Walk a channel's CHATHISTORY back to its end over the wire and report why it stopped.

Usage:
    IRC_PASSWORD=... scripts/chathistory-walk.py HOST PORT ACCOUNT '#channel' [--plain] [--insecure]

Logs in with SASL PLAIN (TLS unless --plain), lets the bouncer restore the
session, then pages BEFORE from the newest message down, 100 rows a page, and
prints each page's span and the reason the walk ended: an empty page, the
chathistory-end tag, a FAIL, or the page cap. Nothing is stored or joined; the
connection QUITs at the end (the held session is untouched).
"""

import base64
import os
import re
import socket
import ssl
import sys
import time

if len(sys.argv) < 5:
    print(__doc__)
    sys.exit(2)

host, port, account, channel = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
plain = "--plain" in sys.argv
# --insecure skips certificate verification (the bed's self-signed cert).
insecure = "--insecure" in sys.argv
password = os.environ.get("IRC_PASSWORD")

if not password:
    print("set IRC_PASSWORD in the environment")
    sys.exit(2)

raw = socket.create_connection((host, port), timeout=8)

if plain:
    sock = raw
else:
    ctx = ssl.create_default_context()

    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    sock = ctx.wrap_socket(raw, server_hostname=host)

buf = b""


def send(line):
    sock.sendall((line + "\r\n").encode())


def read(secs):
    global buf
    out = []
    deadline = time.time() + secs

    while time.time() < deadline:
        try:
            data = sock.recv(1 << 20)
        except socket.timeout:
            break

        if not data:
            break

        buf += data

        while b"\r\n" in buf:
            line, buf = buf.split(b"\r\n", 1)
            line = line.decode(errors="replace")

            if line.startswith("PING"):
                send("PONG " + line[5:])

            out.append(line)

    return out


def rows_of(lines):
    return [l for l in lines if re.match(r"^@\S*batch=", l)]


def times_of(rows):
    return sorted(m.group(1) for l in rows for m in [re.search(r"time=([^;\s]+)", l)] if m)


send("CAP LS 302")
send("NICK histwalk")
send("USER h 0 * :chathistory walk")
read(2)
send("CAP REQ :sasl batch server-time message-tags labeled-response draft/chathistory draft/persistence")
read(1)
send("AUTHENTICATE PLAIN")
read(1)
send("AUTHENTICATE " + base64.b64encode(f"{account}\0{account}\0{password}".encode()).decode())
got = read(4)

if not any(" 903 " in l for l in got):
    print("SASL failed:", [l for l in got if " 90" in l][:2])
    sys.exit(1)

send("CAP END")
got = read(8)
restored = sorted({m.group(1) for l in got for m in [re.search(r" JOIN (#\S+)", l)] if m})
print("persistence:", [l.split(":", 2)[-1] for l in got if "PERSISTENCE" in l][:2])
print("restored channels:", len(restored), restored[:12])

for line in got:
    if " 005 " in line and "CHATHISTORY" in line:
        print("isupport:", " ".join(t for t in line.split() if "HISTORY" in t or "MSGREF" in t))

send(f"@label=l CHATHISTORY LATEST {channel} * 100")
got = read(5)
rows = rows_of(got)
times = times_of(rows)
fails = [l for l in got if "FAIL" in l]
print(f"LATEST: rows={len(rows)} span={times[0] if times else None}..{times[-1] if times else None} fail={fails[:1]}")

if not times:
    send("QUIT :walk done")
    sys.exit(0)

oldest = times[0]
page = 1
total = len(rows)

while page < 40:
    send(f"@label=p CHATHISTORY BEFORE {channel} timestamp={oldest} 100")
    got = read(5)
    rows = rows_of(got)
    times = times_of(rows)
    end = any("chathistory-end" in l for l in got)
    fails = [l for l in got if "FAIL" in l]

    if fails:
        print(f"page {page + 1}: FAIL {fails[0]}")
        break

    if not rows:
        print(f"page {page + 1}: EMPTY{' with chathistory-end' if end else ''} (asked before {oldest})")
        break

    page += 1
    total += len(rows)
    print(f"page {page}: rows={len(rows)} span={times[0]}..{times[-1]}{' END TAG' if end else ''}")
    oldest = min(oldest, times[0])

    if end:
        break

print(f"walk: pages={page} rows={total} oldest reached={oldest}")
send("QUIT :walk done")
