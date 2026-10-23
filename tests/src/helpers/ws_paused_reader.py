#!/usr/bin/env python3
"""A WebSocket IRC client with a tiny TCP receive buffer, driven over stdin.

Node cannot set SO_RCVBUF on a TCP socket, and the WebSocket out-of-band
frame bug needs the peer's receive window to CLOSE (a phone that stopped
reading) with the server's send queue empty.  A 4 KB receive buffer makes
that state reachable in a few lines instead of a few hundred kilobytes.

Usage: ws_paused_reader.py HOST PORT RCVBUF [plain]
  "plain" speaks IRC over TLS directly (no WebSocket layer); "ping" is
  then ignored.  Server WebSocket PINGs are reported but not answered:
  a pile of PONGs on resume would trip the server's control-frame meter.

Commands (one per stdin line):
  pause         stop reading the socket (the kernel keeps acking until the
                receive buffer is full, then the window closes)
  resume        read again; buffered frames are delivered as events
  ping <text>   send a WebSocket PING frame with that payload
  send <line>   send one IRC line as a TEXT frame
  inq           report the bytes waiting in the kernel receive queue
                (event "inq <n>"; it stops growing once the window is closed)
  quit          close the socket and exit
Events (one per stdout line):
  ready                     handshake done
  line <irc line>           an IRC line received (IRC PINGs are answered)
  pong <text>               a WebSocket PONG frame received
  wsping                    a WebSocket PING frame received (answered)
  closed <reason>           the socket closed or failed
"""
import array
import base64
import fcntl
import hashlib
import os
import select
import socket
import ssl
import struct
import sys
import termios

host, port, rcvbuf = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
PLAIN = len(sys.argv) > 4 and sys.argv[4] == "plain"


def emit(s: str) -> None:
    sys.stdout.write(s + "\n")
    sys.stdout.flush()


def frame(opcode: int, payload: bytes) -> bytes:
    mask = os.urandom(4)
    hdr = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        hdr += bytes([0x80 | n])
    elif n < 65536:
        hdr += bytes([0x80 | 126]) + struct.pack("!H", n)
    else:
        hdr += bytes([0x80 | 127]) + struct.pack("!Q", n)
    return hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


raw = None
err = None
for info in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM):
    raw = socket.socket(info[0], socket.SOCK_STREAM)
    raw.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)   # before connect: fixes the window
    try:
        raw.connect(info[4])
        break
    except OSError as e:
        err = e
        raw.close()
        raw = None
if raw is None:
    emit(f"closed connect {err}")
    sys.exit(1)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
sock = ctx.wrap_socket(raw, server_hostname=host)
sock.settimeout(5)

buf = b""
if PLAIN:
    emit("ready")
else:
  key = base64.b64encode(os.urandom(16)).decode()
  sock.sendall((
      "GET / HTTP/1.1\r\n"
      f"Host: {host}:{port}\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      f"Sec-WebSocket-Key: {key}\r\n"
      "Sec-WebSocket-Version: 13\r\n\r\n"
  ).encode())
  while b"\r\n\r\n" not in buf:
      chunk = sock.recv(4096)
      if not chunk:
          emit("closed handshake eof")
          sys.exit(1)
      buf += chunk
  head, buf = buf.split(b"\r\n\r\n", 1)
  expect = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
  if b" 101 " not in head.split(b"\r\n")[0] or expect.encode() not in head:
      emit("closed handshake " + head.split(b"\r\n")[0].decode(errors="replace"))
      sys.exit(1)
  emit("ready")

paused = False
text = b""


def tx_line(line: str) -> None:
    data = (line + "\r\n").encode()
    sock.sendall(data if PLAIN else frame(0x1, data))


def handle_plain() -> None:
    """Plain TLS: split buf into IRC lines; answer PING."""
    global buf
    while b"\r\n" in buf:
        line, buf = buf.split(b"\r\n", 1)
        if not line:
            continue
        s = line.decode(errors="replace")
        if s.startswith("PING "):
            tx_line("PONG " + s[5:])
        emit("line " + s)


def handle_input() -> None:
    if PLAIN:
        handle_plain()
    else:
        handle_frames()


def handle_frames() -> None:
    """Parse every complete frame in buf; emit events; answer pings."""
    global buf, text
    while True:
        if len(buf) < 2:
            return
        b0, b1 = buf[0], buf[1]
        fin, opcode = b0 & 0x80, b0 & 0x0F
        masked, n = b1 & 0x80, b1 & 0x7F
        off = 2
        if n == 126:
            if len(buf) < 4:
                return
            n = struct.unpack("!H", buf[2:4])[0]
            off = 4
        elif n == 127:
            if len(buf) < 10:
                return
            n = struct.unpack("!Q", buf[2:10])[0]
            off = 10
        if masked:
            off += 4
        if len(buf) < off + n:
            return
        payload = buf[off:off + n]
        if masked:
            m = buf[off - 4:off]
            payload = bytes(b ^ m[i % 4] for i, b in enumerate(payload))
        buf = buf[off + n:]
        if opcode in (0x1, 0x2, 0x0):
            text += payload
            if fin:
                for line in text.split(b"\r\n"):
                    if not line:
                        continue
                    s = line.decode(errors="replace")
                    if s.startswith("PING "):
                        tx_line("PONG " + s[5:])
                    emit("line " + s)
                text = b""
        elif opcode == 0x9:
            emit("wsping")
        elif opcode == 0xA:
            emit("pong " + payload.decode(errors="replace"))
        elif opcode == 0x8:
            code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 0
            emit(f"closed ws {code} {payload[2:].decode(errors='replace')}")
            sys.exit(0)


def handle_cmd(cmd: str) -> None:
    global paused
    if cmd == "pause":
        paused = True
    elif cmd == "resume":
        paused = False
        handle_input()
    elif cmd.startswith("ping "):
        if not PLAIN:
            sock.sendall(frame(0x9, cmd[5:].encode()))
    elif cmd.startswith("send "):
        tx_line(cmd[5:])
    elif cmd == "inq":
        n = array.array("i", [0])
        fcntl.ioctl(sock.fileno(), termios.FIONREAD, n)
        emit(f"inq {n[0]}")
    elif cmd == "quit":
        try:
            if PLAIN:
                tx_line("QUIT")
            else:
                sock.sendall(frame(0x8, struct.pack("!H", 1000)))
        except OSError:
            pass
        sys.exit(0)


# stdin is read unbuffered: a buffered readline would swallow several
# commands at once and select() would not wake for the ones left in the
# buffer.
pending = b""
while True:
    watch = [0] if paused else [0, sock]
    try:
        readable, _, _ = select.select(watch, [], [], 0.5)
    except (OSError, ValueError) as e:
        emit(f"closed select {e}")
        sys.exit(0)
    if sock in readable:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            chunk = b"-"  # a partial TLS record; try again
        except (OSError, ssl.SSLError) as e:
            emit(f"closed recv {e}")
            sys.exit(0)
        if chunk == b"":
            emit("closed eof")
            sys.exit(0)
        if chunk != b"-":
            buf += chunk
            handle_input()
    if 0 in readable:
        data = os.read(0, 65536)
        if not data:
            sys.exit(0)
        pending += data
        lines = pending.split(b"\n")
        pending = lines.pop()
        for raw_cmd in lines:
            try:
                handle_cmd(raw_cmd.decode().rstrip("\r"))
            except (OSError, ssl.SSLError) as e:
                emit(f"closed send {e}")
                sys.exit(0)
